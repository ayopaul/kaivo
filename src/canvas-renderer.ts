export type RenderMode = 'pinch' | 'scroll-morph' | 'combined';

interface TextRun {
  text: string;
  href?: string; // if set, this run is a clickable link
}

interface TextLine {
  kind: 'text';
  runs: TextRun[];
  y: number;
  baseFontSize: number;
}

interface ImageBlock {
  kind: 'image';
  canvas: HTMLCanvasElement;
  y: number;
  displayWidth: number;
  displayHeight: number;
}

type Block = TextLine | ImageBlock;

export interface PageImage {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

// Stored link region for click detection (in layout space, pre-scroll/zoom)
interface LinkRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  href: string;
}

export class CanvasRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private blocks: Block[] = [];
  private scrollY = 0;
  private targetScrollY = 0;
  private pinchScale = 1;
  private targetPinchScale = 1;
  private mode: RenderMode = 'combined';
  private rafId = 0;
  private totalHeight = 0;

  // Raw content for re-layout on zoom
  private rawText = '';
  private rawPageImages?: PageImage[];
  private lastLayoutScale = 1;

  // Spring physics velocities
  private scrollVelocitySpring = 0;
  private zoomVelocitySpring = 0;

  // Touch tracking
  private lastTouchY = 0;
  private touchVelocity = 0;
  private isPinching = false;
  private initialPinchDist = 0;
  private initialPinchScale = 1;

  // Config
  private baseFontSize = 18;
  private lineHeight = 1.7;
  private padding = 40;
  private pageGap = 30;
  private fontFamily = "'Inter', system-ui, sans-serif";

  // Bionic reading
  private bionic = false;

  // Morph config
  private morphRadius = 0.35;
  private morphStrength = 1.8;

  // Scroll direction tracking
  private prevScrollY = 0;
  private scrollDirection: 'up' | 'down' = 'down';

  // Bookmark positions (as fractions 0–1 of totalHeight)
  private bookmarkPositions: number[] = [];

  // Link regions for click detection
  private linkRegions: LinkRegion[] = [];

  // Callbacks
  onProgress?: (progress: number, direction: 'up' | 'down') => void;

  // Bound handlers
  private _onWheel!: (e: WheelEvent) => void;
  private _onTouchStart!: (e: TouchEvent) => void;
  private _onTouchMove!: (e: TouchEvent) => void;
  private _onTouchEnd!: (e: TouchEvent) => void;
  private _onResize!: () => void;
  private _onClick!: (e: MouseEvent) => void;
  private _onMouseMove!: (e: MouseEvent) => void;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    this.resize();
    this.bindEvents();
    this.loop();
  }

  setContent(text: string, pageImages?: PageImage[]) {
    this.rawText = text;
    this.rawPageImages = pageImages;

    this.scrollY = 0;
    this.targetScrollY = 0;
    this.pinchScale = 1;
    this.targetPinchScale = 1;
    this.lastLayoutScale = 1;
    this.blocks = [];
    this.linkRegions = [];

    const viewWidth = this.canvas.getBoundingClientRect().width;
    const isMorph = this.mode === 'scroll-morph' || this.mode === 'combined';

    if (pageImages && pageImages.length > 0) {
      this.layoutImages(pageImages, viewWidth);
    } else {
      const effectiveWidth = isMorph ? viewWidth / this.morphStrength : viewWidth;
      this.layoutText(text, effectiveWidth);
    }
  }

  setMode(mode: RenderMode) {
    const prevMode = this.mode;
    this.mode = mode;

    const wasMorph = prevMode === 'scroll-morph' || prevMode === 'combined';
    const isMorph = mode === 'scroll-morph' || mode === 'combined';
    if (wasMorph !== isMorph && this.rawText) {
      const viewWidth = this.canvas.getBoundingClientRect().width;
      const effectiveWidth = isMorph ? viewWidth / this.morphStrength : viewWidth;
      this.blocks = [];
      this.linkRegions = [];
      this.layoutText(this.rawText, effectiveWidth / this.pinchScale);
    }
  }

  setBionic(enabled: boolean) {
    this.bionic = enabled;
  }

  setBookmarks(positions: number[]) {
    this.bookmarkPositions = positions;
  }

  getProgress(): number {
    const viewH = this.canvas.getBoundingClientRect().height;
    const scaledHeight = this.totalHeight * this.pinchScale;
    const maxScroll = Math.max(0, scaledHeight - viewH);
    if (maxScroll <= 0) return 1;
    return Math.min(1, Math.max(0, this.scrollY / maxScroll));
  }

  setScrollProgress(pct: number) {
    const viewH = this.canvas.getBoundingClientRect().height;
    const scaledHeight = this.totalHeight * this.pinchScale;
    const maxScroll = Math.max(0, scaledHeight - viewH);
    this.targetScrollY = pct * maxScroll;
    this.scrollY = this.targetScrollY;
    this.clampScroll();
  }

  getScrollFraction(): number {
    const scaledHeight = this.totalHeight * this.pinchScale;
    if (scaledHeight <= 0) return 0;
    return this.scrollY / scaledHeight;
  }

  destroy() {
    cancelAnimationFrame(this.rafId);
    this.unbindEvents();
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    this.canvas.width = rect.width * dpr;
    this.canvas.height = rect.height * dpr;
    this.ctx.scale(dpr, dpr);
  }

  // ── Layout ──

  private layoutImages(pageImages: PageImage[], viewWidth: number) {
    let y = this.padding;
    const maxWidth = viewWidth - this.padding * 2;

    for (const img of pageImages) {
      const scale = maxWidth / img.width;
      const displayWidth = maxWidth;
      const displayHeight = img.height * scale;

      this.blocks.push({
        kind: 'image',
        canvas: img.canvas,
        y,
        displayWidth,
        displayHeight,
      });

      y += displayHeight + this.pageGap;
    }

    this.totalHeight = y + this.padding;
  }

  /**
   * Parse text with embedded link markers (\x01url\x02text\x03)
   * into an array of TextRun objects for a given string.
   */
  private parseRuns(text: string): TextRun[] {
    const runs: TextRun[] = [];
    let i = 0;

    while (i < text.length) {
      const linkStart = text.indexOf('\x01', i);

      if (linkStart === -1) {
        // No more links — rest is plain text
        const remaining = text.slice(i);
        if (remaining) runs.push({ text: remaining });
        break;
      }

      // Plain text before the link
      if (linkStart > i) {
        runs.push({ text: text.slice(i, linkStart) });
      }

      const urlEnd = text.indexOf('\x02', linkStart + 1);
      const linkEnd = text.indexOf('\x03', urlEnd + 1);

      if (urlEnd === -1 || linkEnd === -1) {
        // Malformed marker — treat rest as plain text
        runs.push({ text: text.slice(linkStart) });
        break;
      }

      const href = text.slice(linkStart + 1, urlEnd);
      const linkText = text.slice(urlEnd + 1, linkEnd);

      if (linkText) {
        runs.push({ text: linkText, href });
      }

      i = linkEnd + 1;
    }

    return runs;
  }

  /** Strip link markers for plain text measurement */
  private stripMarkers(text: string): string {
    return text.replace(/\x01[^\x02]*\x02([^\x03]*)\x03/g, '$1');
  }

  private layoutText(text: string, viewWidth: number) {
    const maxWidth = viewWidth - this.padding * 2;
    const fontSize = this.baseFontSize;
    this.ctx.font = `${fontSize}px ${this.fontFamily}`;

    let y = this.padding;
    const paragraphs = text.split(/\n+/);

    for (const para of paragraphs) {
      if (this.stripMarkers(para).trim() === '') {
        y += fontSize * this.lineHeight * 0.5;
        continue;
      }

      // Parse paragraph into runs, then tokenize into words preserving run info
      const runs = this.parseRuns(para);
      const tokens: { word: string; href?: string }[] = [];

      for (const run of runs) {
        const words = run.text.split(/(\s+)/);
        for (const w of words) {
          if (w) tokens.push({ word: w, href: run.href });
        }
      }

      // Word-wrap tokens into lines
      let lineRuns: TextRun[] = [];
      let lineWidth = 0;

      const flushLine = () => {
        if (lineRuns.length === 0) return;
        // Merge adjacent runs with same href
        const merged = this.mergeRuns(lineRuns);
        this.blocks.push({ kind: 'text', runs: merged, y, baseFontSize: fontSize });

        // Record link regions for click detection
        let xOffset = this.padding;
        for (const run of merged) {
          const w = this.ctx.measureText(run.text).width;
          if (run.href) {
            this.linkRegions.push({
              x: xOffset,
              y: y - fontSize,
              width: w,
              height: fontSize * this.lineHeight,
              href: run.href,
            });
          }
          xOffset += w;
        }

        y += fontSize * this.lineHeight;
        lineRuns = [];
        lineWidth = 0;
      };

      for (const token of tokens) {
        if (/^\s+$/.test(token.word)) {
          // Whitespace
          const spaceW = this.ctx.measureText(token.word).width;
          lineWidth += spaceW;
          lineRuns.push({ text: token.word, href: token.href });
          continue;
        }

        const wordW = this.ctx.measureText(token.word).width;

        if (lineWidth + wordW > maxWidth && lineWidth > 0) {
          // Wrap: remove trailing whitespace from current line
          while (lineRuns.length > 0 && /^\s+$/.test(lineRuns[lineRuns.length - 1].text)) {
            lineRuns.pop();
          }
          flushLine();
        }

        lineRuns.push({ text: token.word, href: token.href });
        lineWidth += wordW;
      }

      // Flush remaining
      while (lineRuns.length > 0 && /^\s+$/.test(lineRuns[lineRuns.length - 1].text)) {
        lineRuns.pop();
      }
      flushLine();

      y += fontSize * this.lineHeight * 0.3;
    }

    this.totalHeight = y + this.padding;
  }

  /** Merge adjacent TextRuns that share the same href (or lack thereof) */
  private mergeRuns(runs: TextRun[]): TextRun[] {
    if (runs.length === 0) return [];
    const merged: TextRun[] = [{ ...runs[0] }];
    for (let i = 1; i < runs.length; i++) {
      const prev = merged[merged.length - 1];
      if (prev.href === runs[i].href) {
        prev.text += runs[i].text;
      } else {
        merged.push({ ...runs[i] });
      }
    }
    return merged;
  }

  /** Re-layout text for current zoom */
  private relayoutForZoom() {
    const isTextMode = !this.rawPageImages || this.rawPageImages.length === 0;
    if (!isTextMode) return;

    const viewWidth = this.canvas.getBoundingClientRect().width;
    const isMorph = this.mode === 'scroll-morph' || this.mode === 'combined';
    const effectiveWidth = (isMorph ? viewWidth / this.morphStrength : viewWidth) / this.pinchScale;

    const viewH = this.canvas.getBoundingClientRect().height;
    const oldMaxScroll = Math.max(1, this.totalHeight * this.lastLayoutScale - viewH);
    const scrollPct = this.scrollY / oldMaxScroll;

    this.blocks = [];
    this.linkRegions = [];
    this.layoutText(this.rawText, effectiveWidth);
    this.lastLayoutScale = this.pinchScale;

    const newMaxScroll = Math.max(0, this.totalHeight * this.pinchScale - viewH);
    this.scrollY = scrollPct * newMaxScroll;
    this.targetScrollY = this.scrollY;
    this.clampScroll();
  }

  // ── Events ──

  private bindEvents() {
    this._onWheel = this.onWheel.bind(this);
    this._onTouchStart = this.onTouchStart.bind(this);
    this._onTouchMove = this.onTouchMove.bind(this);
    this._onTouchEnd = this.onTouchEnd.bind(this);
    this._onResize = this.onResize.bind(this);
    this._onClick = this.onClick.bind(this);
    this._onMouseMove = this.onMouseMove.bind(this);

    this.canvas.addEventListener('wheel', this._onWheel, { passive: false });
    this.canvas.addEventListener('touchstart', this._onTouchStart, { passive: false });
    this.canvas.addEventListener('touchmove', this._onTouchMove, { passive: false });
    this.canvas.addEventListener('touchend', this._onTouchEnd);
    this.canvas.addEventListener('click', this._onClick);
    this.canvas.addEventListener('mousemove', this._onMouseMove);
    window.addEventListener('resize', this._onResize);
  }

  private unbindEvents() {
    this.canvas.removeEventListener('wheel', this._onWheel);
    this.canvas.removeEventListener('touchstart', this._onTouchStart);
    this.canvas.removeEventListener('touchmove', this._onTouchMove);
    this.canvas.removeEventListener('touchend', this._onTouchEnd);
    this.canvas.removeEventListener('click', this._onClick);
    this.canvas.removeEventListener('mousemove', this._onMouseMove);
    window.removeEventListener('resize', this._onResize);
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    if (e.ctrlKey) {
      const delta = -e.deltaY * 0.01;
      this.targetPinchScale = Math.max(0.5, Math.min(3, this.targetPinchScale + delta));
    } else {
      this.targetScrollY += e.deltaY;
      this.clampScroll();
    }
  }

  private onTouchStart(e: TouchEvent) {
    if (e.touches.length === 1) {
      this.lastTouchY = e.touches[0].clientY;
      this.touchVelocity = 0;
      this.isPinching = false;
    } else if (e.touches.length === 2) {
      e.preventDefault();
      this.isPinching = true;
      this.initialPinchDist = this.getTouchDist(e.touches);
      this.initialPinchScale = this.targetPinchScale;
    }
  }

  private onTouchMove(e: TouchEvent) {
    e.preventDefault();
    if (e.touches.length === 1 && !this.isPinching) {
      const y = e.touches[0].clientY;
      const delta = this.lastTouchY - y;
      this.touchVelocity = delta;
      this.targetScrollY += delta;
      this.clampScroll();
      this.lastTouchY = y;
    } else if (e.touches.length === 2) {
      const dist = this.getTouchDist(e.touches);
      const scale = dist / this.initialPinchDist;
      this.targetPinchScale = Math.max(0.5, Math.min(3, this.initialPinchScale * scale));
    }
  }

  private onTouchEnd(_e: TouchEvent) {
    if (!this.isPinching && Math.abs(this.touchVelocity) > 2) {
      this.targetScrollY += this.touchVelocity * 8;
      this.clampScroll();
    }
    this.isPinching = false;
  }

  private onResize() {
    this.resize();
  }

  /** Convert canvas click coordinates to content space and check for link hits */
  private onClick(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    const baseScale = (this.mode === 'pinch' || this.mode === 'combined')
      ? this.pinchScale : 1;

    // Convert screen coords to layout coords
    const layoutX = clickX / baseScale;
    const layoutY = (clickY + this.scrollY) / baseScale;

    for (const region of this.linkRegions) {
      if (
        layoutX >= region.x &&
        layoutX <= region.x + region.width &&
        layoutY >= region.y &&
        layoutY <= region.y + region.height
      ) {
        window.open(region.href, '_blank', 'noopener,noreferrer');
        return;
      }
    }
  }

  /** Update cursor on hover over links */
  private onMouseMove(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const baseScale = (this.mode === 'pinch' || this.mode === 'combined')
      ? this.pinchScale : 1;

    const layoutX = mouseX / baseScale;
    const layoutY = (mouseY + this.scrollY) / baseScale;

    let overLink = false;
    for (const region of this.linkRegions) {
      if (
        layoutX >= region.x &&
        layoutX <= region.x + region.width &&
        layoutY >= region.y &&
        layoutY <= region.y + region.height
      ) {
        overLink = true;
        break;
      }
    }

    this.canvas.style.cursor = overLink ? 'pointer' : 'default';
  }

  private getTouchDist(touches: TouchList): number {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  private clampScroll() {
    const viewH = this.canvas.getBoundingClientRect().height;
    const maxScroll = Math.max(0, this.totalHeight * this.pinchScale - viewH);
    this.targetScrollY = Math.max(0, Math.min(maxScroll, this.targetScrollY));
  }

  // ── Render loop ──

  private loop() {
    // Spring physics for scroll
    this.scrollVelocitySpring += (this.targetScrollY - this.scrollY) * 0.14;
    this.scrollVelocitySpring *= 0.78;
    this.scrollY += this.scrollVelocitySpring;

    // Spring physics for zoom
    this.zoomVelocitySpring += (this.targetPinchScale - this.pinchScale) * 0.06;
    this.zoomVelocitySpring *= 0.82;
    this.pinchScale += this.zoomVelocitySpring;

    // Re-layout text when zoom changes
    const scaleChanged = Math.abs(this.pinchScale - this.lastLayoutScale) > 0.03;
    const isTextMode = !this.rawPageImages || this.rawPageImages.length === 0;
    if (isTextMode && scaleChanged) {
      this.relayoutForZoom();
    }

    // Track scroll direction
    const delta = this.scrollY - this.prevScrollY;
    if (Math.abs(delta) > 0.5) {
      this.scrollDirection = delta > 0 ? 'down' : 'up';
    }
    this.prevScrollY = this.scrollY;

    if (this.onProgress) {
      this.onProgress(this.getProgress(), this.scrollDirection);
    }

    this.render();
    this.rafId = requestAnimationFrame(() => this.loop());
  }

  private render() {
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    this.ctx.clearRect(0, 0, w, h);

    const viewCenterY = h / 2;
    const morphRadiusPx = h * this.morphRadius;

    for (const block of this.blocks) {
      const baseScale = (this.mode === 'pinch' || this.mode === 'combined')
        ? this.pinchScale : 1;

      if (block.kind === 'text') {
        const drawY = block.y * baseScale - this.scrollY;
        if (drawY < -100 || drawY > h + 100) continue;

        let morphScale = 1;
        let morphAlpha = 1;

        if (this.mode === 'scroll-morph' || this.mode === 'combined') {
          const distFromCenter = Math.abs(drawY - viewCenterY);
          const normalizedDist = Math.min(distFromCenter / morphRadiusPx, 1);
          const falloff = (1 + Math.cos(normalizedDist * Math.PI)) / 2;
          morphScale = 1 + (this.morphStrength - 1) * falloff;
          morphAlpha = 0.3 + 0.7 * falloff;
        }

        const finalFontSize = block.baseFontSize * baseScale * morphScale;

        this.ctx.save();
        this.ctx.globalAlpha = morphAlpha;

        if (this.bionic) {
          this.drawBionicRuns(block.runs, this.padding * baseScale, drawY, finalFontSize);
        } else {
          this.drawRuns(block.runs, this.padding * baseScale, drawY, finalFontSize);
        }

        this.ctx.restore();
      } else if (block.kind === 'image') {
        const drawY = block.y * baseScale - this.scrollY;
        const drawW = block.displayWidth * baseScale;
        const drawH = block.displayHeight * baseScale;

        if (drawY + drawH < -50 || drawY > h + 50) continue;

        let morphAlpha = 1;
        if (this.mode === 'scroll-morph' || this.mode === 'combined') {
          const imgCenterY = drawY + drawH / 2;
          const distFromCenter = Math.abs(imgCenterY - viewCenterY);
          const normalizedDist = Math.min(distFromCenter / (morphRadiusPx * 2), 1);
          const falloff = (1 + Math.cos(normalizedDist * Math.PI)) / 2;
          morphAlpha = 0.3 + 0.7 * falloff;
        }

        this.ctx.save();
        this.ctx.globalAlpha = morphAlpha;
        this.ctx.drawImage(block.canvas, this.padding * baseScale, drawY, drawW, drawH);
        this.ctx.restore();
      }
    }

    this.renderBookmarkMarkers(w, h);
  }

  /** Draw runs with link styling */
  private drawRuns(runs: TextRun[], x: number, y: number, fontSize: number) {
    let cursorX = x;

    for (const run of runs) {
      this.ctx.font = `${fontSize}px ${this.fontFamily}`;

      if (run.href) {
        // Link styling: blue color + underline
        this.ctx.fillStyle = '#6db3f2';
        this.ctx.fillText(run.text, cursorX, y);

        const textWidth = this.ctx.measureText(run.text).width;

        // Draw underline
        this.ctx.strokeStyle = '#6db3f2';
        this.ctx.lineWidth = Math.max(1, fontSize * 0.06);
        this.ctx.globalAlpha = this.ctx.globalAlpha * 0.6;
        this.ctx.beginPath();
        this.ctx.moveTo(cursorX, y + fontSize * 0.15);
        this.ctx.lineTo(cursorX + textWidth, y + fontSize * 0.15);
        this.ctx.stroke();
        // Restore alpha
        this.ctx.globalAlpha = this.ctx.globalAlpha / 0.6;

        cursorX += textWidth;
      } else {
        this.ctx.fillStyle = '#e8e8e8';
        this.ctx.fillText(run.text, cursorX, y);
        cursorX += this.ctx.measureText(run.text).width;
      }
    }
  }

  /** Draw bionic-styled runs (with link support) */
  private drawBionicRuns(runs: TextRun[], x: number, y: number, fontSize: number) {
    let cursorX = x;

    for (const run of runs) {
      const words = run.text.split(/(\s+)/);

      for (const token of words) {
        if (/^\s+$/.test(token)) {
          this.ctx.font = `${fontSize}px ${this.fontFamily}`;
          cursorX += this.ctx.measureText(token).width;
          continue;
        }

        const boldLen = Math.ceil(token.length / 2);
        const boldPart = token.slice(0, boldLen);
        const lightPart = token.slice(boldLen);

        const baseColor = run.href ? '#6db3f2' : '#e8e8e8';
        const lightColor = run.href ? '#4a8ac7' : '#999';

        this.ctx.font = `700 ${fontSize}px ${this.fontFamily}`;
        this.ctx.fillStyle = baseColor;
        this.ctx.fillText(boldPart, cursorX, y);
        cursorX += this.ctx.measureText(boldPart).width;

        if (lightPart) {
          this.ctx.font = `300 ${fontSize}px ${this.fontFamily}`;
          this.ctx.fillStyle = lightColor;
          this.ctx.fillText(lightPart, cursorX, y);
          cursorX += this.ctx.measureText(lightPart).width;
        }
      }
    }
  }

  private renderBookmarkMarkers(w: number, h: number) {
    if (this.bookmarkPositions.length === 0) return;

    const viewH = h;
    const scaledHeight = this.totalHeight * this.pinchScale;
    const maxScroll = Math.max(1, scaledHeight - viewH);

    for (const pct of this.bookmarkPositions) {
      const bookmarkScroll = pct * scaledHeight;
      const screenY = ((bookmarkScroll - this.scrollY) / maxScroll) * viewH;

      if (screenY < -20 || screenY > viewH + 20) continue;

      this.ctx.save();
      this.ctx.fillStyle = '#f59e0b';
      this.ctx.globalAlpha = 0.8;

      const markerSize = 8;
      this.ctx.beginPath();
      this.ctx.moveTo(w, screenY - markerSize);
      this.ctx.lineTo(w - markerSize * 1.5, screenY);
      this.ctx.lineTo(w, screenY + markerSize);
      this.ctx.closePath();
      this.ctx.fill();
      this.ctx.restore();
    }
  }
}
