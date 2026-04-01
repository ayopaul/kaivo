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
  isHeading?: boolean;
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

  /** Compute padding based on viewport width */
  private getPadding(): number {
    const w = this.canvas.getBoundingClientRect().width;
    return w < 500 ? 8 : w < 768 ? 20 : 40;
  }

  /** Even less padding for images on small screens */
  private getImagePadding(): number {
    const w = this.canvas.getBoundingClientRect().width;
    return w < 500 ? 4 : w < 768 ? 16 : 40;
  }

  private getPageGap(): number {
    const w = this.canvas.getBoundingClientRect().width;
    return w < 500 ? 12 : 30;
  }

  // Bionic reading
  private bionic = false;

  // Morph config
  private morphRadius = 0.25;
  private morphStrength = 1.5;

  // Scroll direction tracking
  private prevScrollY = 0;
  private scrollDirection: 'up' | 'down' = 'down';

  // Bookmark positions (as fractions 0–1 of totalHeight)
  private bookmarkPositions: number[] = [];

  // Link regions for click detection
  private linkRegions: LinkRegion[] = [];

  // Text selection
  private selectionStart: { block: number; charIndex: number } | null = null;
  private selectionEnd: { block: number; charIndex: number } | null = null;
  private isSelecting = false;
  private cursorPosition: { block: number; charIndex: number } | null = null;
  private cursorVisible = true;
  private cursorBlinkTimer = 0;

  // Callbacks
  onProgress?: (progress: number, direction: 'up' | 'down') => void;
  onCursorChange?: (charOffset: number) => void;
  onTextSelected?: (text: string) => void;

  // Bound handlers
  private _onWheel!: (e: WheelEvent) => void;
  private _onTouchStart!: (e: TouchEvent) => void;
  private _onTouchMove!: (e: TouchEvent) => void;
  private _onTouchEnd!: (e: TouchEvent) => void;
  private _onResize!: () => void;
  private _onClick!: (e: MouseEvent) => void;
  private _onMouseMove!: (e: MouseEvent) => void;
  private _onMouseDown!: (e: MouseEvent) => void;
  private _onMouseUp!: (e: MouseEvent) => void;
  private _onDblClick!: (e: MouseEvent) => void;
  private _onKeyDown!: (e: KeyboardEvent) => void;

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
    // Reduce layout width to leave room for morph scaling at center
    const morphFactor = (this.mode === 'scroll-morph' || this.mode === 'combined')
      ? this.morphStrength : 1;

    if (pageImages && pageImages.length > 0) {
      this.layoutImages(pageImages, viewWidth);
    } else {
      this.layoutText(text, viewWidth / morphFactor);
    }
  }

  setMode(mode: RenderMode) {
    const prevMode = this.mode;
    this.mode = mode;

    const wasMorph = prevMode === 'scroll-morph' || prevMode === 'combined';
    const isMorph = mode === 'scroll-morph' || mode === 'combined';
    if (wasMorph !== isMorph && this.rawText) {
      const viewWidth = this.canvas.getBoundingClientRect().width;
      const factor = isMorph ? this.morphStrength : 1;
      this.blocks = [];
      this.linkRegions = [];
      this.layoutText(this.rawText, viewWidth / factor / this.pinchScale);
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

  getZoomScale(): number {
    return this.pinchScale;
  }

  setZoomScale(scale: number) {
    this.pinchScale = scale;
    this.targetPinchScale = scale;
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
    const pad = this.getImagePadding();
    const gap = this.getPageGap();
    let y = pad;
    const maxWidth = viewWidth - pad * 2;

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

      y += displayHeight + gap;
    }

    this.totalHeight = y + pad;
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

  /** Strip link and heading markers for plain text measurement */
  private stripMarkers(text: string): string {
    return text.replace(/\x01[^\x02]*\x02([^\x03]*)\x03/g, '$1').replace(/\x04/g, '');
  }

  private layoutText(text: string, viewWidth: number) {
    const pad = this.getPadding();
    const maxWidth = viewWidth - pad * 2;
    const fontSize = this.baseFontSize;
    this.ctx.font = `${fontSize}px ${this.fontFamily}`;

    let y = pad;
    const paragraphs = text.split(/\n+/);

    for (let pIdx = 0; pIdx < paragraphs.length; pIdx++) {
      let para = paragraphs[pIdx];

      // Detect heading marker
      const isHeading = para.startsWith('\x04');
      if (isHeading) para = para.slice(1);

      if (this.stripMarkers(para).trim() === '') {
        y += fontSize * this.lineHeight * 0.5;
        continue;
      }

      // Extra space before headings
      if (isHeading && pIdx > 0) {
        y += fontSize * this.lineHeight * 0.8;
      }

      // Headings use 1.4x font size
      const paraFontSize = isHeading ? fontSize * 1.4 : fontSize;
      this.ctx.font = `${isHeading ? '600 ' : ''}${paraFontSize}px ${this.fontFamily}`;

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
        const merged = this.mergeRuns(lineRuns);
        this.blocks.push({ kind: 'text', runs: merged, y, baseFontSize: paraFontSize, isHeading });

        let xOffset = pad;
        for (const run of merged) {
          const w = this.ctx.measureText(run.text).width;
          if (run.href) {
            this.linkRegions.push({
              x: xOffset,
              y: y - paraFontSize,
              width: w,
              height: paraFontSize * this.lineHeight,
              href: run.href,
            });
          }
          xOffset += w;
        }

        y += paraFontSize * this.lineHeight;
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

      // Extra space after headings, normal gap after body paragraphs
      y += paraFontSize * this.lineHeight * (isHeading ? 0.5 : 0.3);
    }

    this.totalHeight = y + pad;
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
    const morphFactor = isMorph ? this.morphStrength : 1;
    const effectiveWidth = viewWidth / morphFactor / this.pinchScale;

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
    this._onMouseDown = this.onMouseDown.bind(this);
    this._onMouseUp = this.onMouseUp.bind(this);
    this._onDblClick = this.onDblClick.bind(this);
    this._onKeyDown = this.onKeyDown.bind(this);

    this.canvas.addEventListener('wheel', this._onWheel, { passive: false });
    this.canvas.addEventListener('touchstart', this._onTouchStart, { passive: false });
    this.canvas.addEventListener('touchmove', this._onTouchMove, { passive: false });
    this.canvas.addEventListener('touchend', this._onTouchEnd);
    this.canvas.addEventListener('touchcancel', this._onTouchEnd);
    this.canvas.addEventListener('click', this._onClick);
    this.canvas.addEventListener('mousedown', this._onMouseDown);
    this.canvas.addEventListener('mousemove', this._onMouseMove);
    this.canvas.addEventListener('mouseup', this._onMouseUp);
    this.canvas.addEventListener('dblclick', this._onDblClick);
    document.addEventListener('keydown', this._onKeyDown);
    window.addEventListener('resize', this._onResize);

    // Cursor blink
    this.cursorBlinkTimer = window.setInterval(() => {
      this.cursorVisible = !this.cursorVisible;
    }, 530);
  }

  private unbindEvents() {
    this.canvas.removeEventListener('wheel', this._onWheel);
    this.canvas.removeEventListener('touchstart', this._onTouchStart);
    this.canvas.removeEventListener('touchmove', this._onTouchMove);
    this.canvas.removeEventListener('touchend', this._onTouchEnd);
    this.canvas.removeEventListener('touchcancel', this._onTouchEnd);
    this.canvas.removeEventListener('click', this._onClick);
    this.canvas.removeEventListener('mousedown', this._onMouseDown);
    this.canvas.removeEventListener('mousemove', this._onMouseMove);
    this.canvas.removeEventListener('mouseup', this._onMouseUp);
    this.canvas.removeEventListener('dblclick', this._onDblClick);
    document.removeEventListener('keydown', this._onKeyDown);
    window.removeEventListener('resize', this._onResize);
    clearInterval(this.cursorBlinkTimer);
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
    this.isPinching = false;
  }

  private onResize() {
    this.resize();
    // Re-layout content for new viewport size
    if (this.rawText || (this.rawPageImages && this.rawPageImages.length > 0)) {
      const savedProgress = this.getProgress();
      this.blocks = [];
      this.linkRegions = [];
      const viewWidth = this.canvas.getBoundingClientRect().width;
      if (this.rawPageImages && this.rawPageImages.length > 0) {
        this.layoutImages(this.rawPageImages, viewWidth);
      } else {
        const isMorph = this.mode === 'scroll-morph' || this.mode === 'combined';
        const morphFactor = isMorph ? this.morphStrength : 1;
        this.layoutText(this.rawText, viewWidth / morphFactor / this.pinchScale);
      }
      if (savedProgress > 0.001) {
        this.setScrollProgress(savedProgress);
      }
    }
  }

  /** Find which block and character position a screen point maps to */
  private hitTestText(screenX: number, screenY: number): { block: number; charIndex: number } | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = screenX - rect.left;
    const y = screenY - rect.top;

    const baseScale = (this.mode === 'pinch' || this.mode === 'combined') ? this.pinchScale : 1;
    const pad = this.getPadding();

    for (let bi = 0; bi < this.blocks.length; bi++) {
      const block = this.blocks[bi];
      if (block.kind !== 'text') continue;

      const drawY = block.y * baseScale - this.scrollY;
      const lineH = block.baseFontSize * this.lineHeight * baseScale;
      if (y < drawY - lineH || y > drawY + lineH * 0.3) continue;

      // Found the line — now find character position
      this.ctx.font = `${block.isHeading ? '600 ' : ''}${block.baseFontSize * baseScale}px ${this.fontFamily}`;
      const lineText = block.runs.map(r => r.text).join('');
      const startX = pad * baseScale;

      for (let ci = 0; ci <= lineText.length; ci++) {
        const textW = this.ctx.measureText(lineText.slice(0, ci)).width;
        const nextW = ci < lineText.length ? this.ctx.measureText(lineText.slice(0, ci + 1)).width : textW;
        const midX = startX + (textW + nextW) / 2;
        if (x <= midX || ci === lineText.length) {
          return { block: bi, charIndex: ci };
        }
      }

      return { block: bi, charIndex: lineText.length };
    }
    return null;
  }

  /** Get the plain text of a block */
  private getBlockText(blockIndex: number): string {
    const block = this.blocks[blockIndex];
    if (!block || block.kind !== 'text') return '';
    return block.runs.map(r => r.text).join('');
  }

  /** Get selected text between selectionStart and selectionEnd */
  getSelectedText(): string {
    if (!this.selectionStart || !this.selectionEnd) return '';

    let start = this.selectionStart;
    let end = this.selectionEnd;
    if (start.block > end.block || (start.block === end.block && start.charIndex > end.charIndex)) {
      [start, end] = [end, start];
    }

    const parts: string[] = [];
    for (let bi = start.block; bi <= end.block; bi++) {
      const text = this.getBlockText(bi);
      if (!text) continue;
      const s = bi === start.block ? start.charIndex : 0;
      const e = bi === end.block ? end.charIndex : text.length;
      parts.push(text.slice(s, e));
    }
    return parts.join('\n');
  }

  /** Get the cumulative character offset of the cursor position */
  getCursorCharOffset(): number {
    if (!this.cursorPosition) return 0;
    let offset = 0;
    for (let bi = 0; bi < this.cursorPosition.block; bi++) {
      const text = this.getBlockText(bi);
      if (text) offset += text.length + 1; // +1 for line break
    }
    offset += this.cursorPosition.charIndex;
    return offset;
  }

  private onMouseDown(e: MouseEvent) {
    // Don't start selection if it's a touch device simulating mouse
    if (e.button !== 0) return;

    const hit = this.hitTestText(e.clientX, e.clientY);
    if (!hit) return;

    this.isSelecting = true;
    this.selectionStart = hit;
    this.selectionEnd = hit;
    this.cursorPosition = hit;
    this.cursorVisible = true;
    this.onCursorChange?.(this.getCursorCharOffset());
  }

  private onMouseUp(_e: MouseEvent) {
    if (!this.isSelecting) return;
    this.isSelecting = false;

    const selectedText = this.getSelectedText();
    if (selectedText.length > 0) {
      this.onTextSelected?.(selectedText);
    }
  }

  private onDblClick(e: MouseEvent) {
    const hit = this.hitTestText(e.clientX, e.clientY);
    if (!hit) return;

    // Select the word at the cursor
    const text = this.getBlockText(hit.block);
    if (!text) return;

    let wordStart = hit.charIndex;
    let wordEnd = hit.charIndex;

    // Expand backward to word boundary
    while (wordStart > 0 && /\w/.test(text[wordStart - 1])) wordStart--;
    // Expand forward to word boundary
    while (wordEnd < text.length && /\w/.test(text[wordEnd])) wordEnd++;

    if (wordStart < wordEnd) {
      this.selectionStart = { block: hit.block, charIndex: wordStart };
      this.selectionEnd = { block: hit.block, charIndex: wordEnd };
      this.onTextSelected?.(text.slice(wordStart, wordEnd));
    }
  }

  private onKeyDown(e: KeyboardEvent) {
    // Ctrl+C or Cmd+C to copy
    if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
      const text = this.getSelectedText();
      if (text) {
        navigator.clipboard.writeText(text).catch(() => {});
        e.preventDefault();
      }
    }
  }

  /** Handle click — open links or place cursor */
  private onClick(e: MouseEvent) {
    // If text was selected via drag, don't process as a click
    if (this.getSelectedText().length > 0) return;

    const rect = this.canvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    const baseScale = (this.mode === 'pinch' || this.mode === 'combined')
      ? this.pinchScale : 1;

    const layoutX = clickX / baseScale;
    const layoutY = (clickY + this.scrollY) / baseScale;

    // Check links
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

  /** Update cursor style and handle drag selection */
  private onMouseMove(e: MouseEvent) {
    // Handle drag selection
    if (this.isSelecting) {
      const hit = this.hitTestText(e.clientX, e.clientY);
      if (hit) {
        this.selectionEnd = hit;
        this.cursorPosition = hit;
      }
      this.canvas.style.cursor = 'text';
      return;
    }

    const rect = this.canvas.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    const baseScale = (this.mode === 'pinch' || this.mode === 'combined')
      ? this.pinchScale : 1;

    const layoutX = mouseX / baseScale;
    const layoutY = (mouseY + this.scrollY) / baseScale;

    // Check if over a link
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

    // Check if over text
    const overText = this.hitTestText(e.clientX, e.clientY) !== null;

    this.canvas.style.cursor = overLink ? 'pointer' : overText ? 'text' : 'default';
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
    // Direct scroll — no spring, no bounce
    this.scrollY = this.targetScrollY;

    // Direct zoom — no spring, no bounce
    this.pinchScale = this.targetPinchScale;

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

    // Clip to canvas bounds so morphed text doesn't overflow
    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.rect(0, 0, w, h);
    this.ctx.clip();

    const viewCenterY = h / 2;
    const morphRadiusPx = h * this.morphRadius;

    const pad = this.getPadding();

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
          this.drawBionicRuns(block.runs, pad * baseScale, drawY, finalFontSize, block.isHeading);
        } else {
          this.drawRuns(block.runs, pad * baseScale, drawY, finalFontSize, block.isHeading);
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
        const imgPad = this.getImagePadding();
        this.ctx.drawImage(block.canvas, imgPad * baseScale, drawY, drawW, drawH);
        this.ctx.restore();
      }
    }

    // Render text selection highlight and cursor
    this.renderSelection(pad, h);

    this.renderBookmarkMarkers(w, h);

    this.ctx.restore(); // end clip
  }

  private renderSelection(pad: number, viewH: number) {
    const baseScale = (this.mode === 'pinch' || this.mode === 'combined') ? this.pinchScale : 1;

    // Draw selection highlight
    if (this.selectionStart && this.selectionEnd) {
      let start = this.selectionStart;
      let end = this.selectionEnd;
      if (start.block > end.block || (start.block === end.block && start.charIndex > end.charIndex)) {
        [start, end] = [end, start];
      }

      this.ctx.save();
      this.ctx.fillStyle = 'rgba(100, 149, 237, 0.3)';

      for (let bi = start.block; bi <= end.block; bi++) {
        const block = this.blocks[bi];
        if (!block || block.kind !== 'text') continue;

        const drawY = block.y * baseScale - this.scrollY;
        if (drawY < -100 || drawY > viewH + 100) continue;

        const fontSize = block.baseFontSize * baseScale;
        this.ctx.font = `${block.isHeading ? '600 ' : ''}${fontSize}px ${this.fontFamily}`;
        const lineText = block.runs.map(r => r.text).join('');
        const startX = pad * baseScale;

        const s = bi === start.block ? start.charIndex : 0;
        const e = bi === end.block ? end.charIndex : lineText.length;

        if (s === e) continue;

        const x1 = startX + this.ctx.measureText(lineText.slice(0, s)).width;
        const x2 = startX + this.ctx.measureText(lineText.slice(0, e)).width;
        const lineH = fontSize * this.lineHeight;

        this.ctx.fillRect(x1, drawY - fontSize, x2 - x1, lineH);
      }

      this.ctx.restore();
    }

    // Draw blinking cursor
    if (this.cursorPosition && this.cursorVisible && !this.getSelectedText()) {
      const block = this.blocks[this.cursorPosition.block];
      if (block && block.kind === 'text') {
        const drawY = block.y * baseScale - this.scrollY;
        if (drawY > -100 && drawY < viewH + 100) {
          const fontSize = block.baseFontSize * baseScale;
          this.ctx.font = `${block.isHeading ? '600 ' : ''}${fontSize}px ${this.fontFamily}`;
          const lineText = block.runs.map(r => r.text).join('');
          const startX = pad * baseScale;
          const cursorX = startX + this.ctx.measureText(lineText.slice(0, this.cursorPosition.charIndex)).width;

          this.ctx.save();
          this.ctx.strokeStyle = '#e8e8e8';
          this.ctx.lineWidth = 1.5;
          this.ctx.beginPath();
          this.ctx.moveTo(cursorX, drawY - fontSize);
          this.ctx.lineTo(cursorX, drawY + fontSize * 0.2);
          this.ctx.stroke();
          this.ctx.restore();
        }
      }
    }
  }

  /** Draw runs with link styling */
  private drawRuns(runs: TextRun[], x: number, y: number, fontSize: number, isHeading?: boolean) {
    let cursorX = x;
    const weight = isHeading ? '600 ' : '';

    for (const run of runs) {
      this.ctx.font = `${weight}${fontSize}px ${this.fontFamily}`;

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
  private drawBionicRuns(runs: TextRun[], x: number, y: number, fontSize: number, _isHeading?: boolean) {
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
