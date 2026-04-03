const PDFJS_VERSION = '4.8.69';
const PDFJS_CDN = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}`;
let pdfjsLib: any = null;

async function getPdfjs() {
  if (pdfjsLib) return pdfjsLib;

  // Load from CDN to bypass Next.js webpack chunking issues
  // @ts-ignore — runtime URL import, not a module path
  pdfjsLib = await import(/* webpackIgnore: true */ `${PDFJS_CDN}/legacy/build/pdf.mjs`);
  pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_CDN}/legacy/build/pdf.worker.min.mjs`;
  return pdfjsLib;
}

export interface PageImage {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

export interface TocEntry {
  title: string;
  level: number;
  position: number;
}

export interface BookData {
  title: string;
  pageImages: PageImage[];
  allText: string;
  toc: TocEntry[];
  fileType: 'pdf' | 'epub';
  coverImage?: string; // data URL of cover thumbnail
}

function isMobile(): boolean {
  return window.innerWidth < 768 ||
    /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && window.innerWidth < 1024);
}

export async function extractPdf(
  file: File,
  onProgress?: (current: number, total: number) => void
): Promise<BookData> {
  const pdfjs = await getPdfjs();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;

  const textParts: string[] = [];
  const totalPages = pdf.numPages;

  for (let i = 1; i <= totalPages; i++) {
    onProgress?.(i, totalPages);

    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = extractPageText(content.items);
    if (pageText.trim()) textParts.push(pageText.trim());

    if (i % 5 === 0) {
      await new Promise(r => setTimeout(r, 0));
    }
  }

  const allText = textParts.join('\n\n\x05\n\n');

  let pageImages: PageImage[] = [];
  if (allText.length < 200 && totalPages > 0) {
    const mobile = isMobile();
    const renderScale = mobile ? 1 : 1.5;

    for (let i = 1; i <= totalPages; i++) {
      onProgress?.(i, totalPages);

      const page = await pdf.getPage(i);
      const viewport = page.getViewport({ scale: renderScale });

      const offscreen = document.createElement('canvas');
      offscreen.width = viewport.width;
      offscreen.height = viewport.height;
      const offCtx = offscreen.getContext('2d')!;

      await page.render({ canvasContext: offCtx, viewport, canvas: offscreen } as any).promise;

      offCtx.filter = 'grayscale(1)';
      offCtx.drawImage(offscreen, 0, 0);
      offCtx.filter = 'none';

      pageImages.push({
        canvas: offscreen,
        width: viewport.width,
        height: viewport.height,
      });

      if (i % 3 === 0) {
        await new Promise(r => setTimeout(r, 0));
      }
    }
  }

  const toc = await extractPdfOutline(pdf);
  const title = file.name.replace(/\.pdf$/i, '');

  // Strip inline TOC from text if outline has entries
  let finalText = allText;
  if (toc.length > 0) {
    finalText = stripInlineToc(allText, toc);
  }

  // Extract cover thumbnail from first page
  let coverImage: string | undefined;
  try {
    const coverPage = await pdf.getPage(1);
    const vp = coverPage.getViewport({ scale: 0.5 });
    const thumbW = Math.min(200, vp.width);
    const scale = thumbW / vp.width * 0.5;
    const thumbVp = coverPage.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = thumbVp.width;
    c.height = thumbVp.height;
    await coverPage.render({ canvasContext: c.getContext('2d')!, viewport: thumbVp }).promise;
    coverImage = c.toDataURL('image/jpeg', 0.7);
  } catch { /* ignore */ }

  return { title, pageImages, allText: finalText, toc, fileType: 'pdf', coverImage };
}

/** Extract text from page items, detecting paragraphs and headings from layout */
function extractPageText(items: any[]): string {
  if (items.length === 0) return '';

  const rawLines: { text: string; fontSize: number; y: number }[] = [];
  let currentText = '';
  let lastY: number | null = null;
  let lastFontSize = 12;
  let currentFontSize = 12;

  for (const item of items) {
    if (!item.str && item.str !== '') continue;

    const y = item.transform ? item.transform[5] : null;
    const fs = item.transform
      ? Math.abs(item.transform[0]) || Math.abs(item.transform[3]) || 12
      : 12;

    if (lastY !== null && y !== null) {
      const yDiff = Math.abs(lastY - y);
      if (yDiff > lastFontSize * 0.3) {
        if (currentText.trim()) {
          rawLines.push({ text: currentText.trim(), fontSize: currentFontSize, y: lastY });
        }
        currentText = '';
        currentFontSize = fs;
      }
    }

    currentText += item.str;
    if (y !== null) lastY = y;
    lastFontSize = fs;
    if (!currentFontSize) currentFontSize = fs;
  }
  if (currentText.trim()) {
    rawLines.push({ text: currentText.trim(), fontSize: currentFontSize, y: lastY || 0 });
  }

  if (rawLines.length === 0) return '';

  const fontCounts = new Map<number, number>();
  for (const line of rawLines) {
    const rounded = Math.round(line.fontSize);
    fontCounts.set(rounded, (fontCounts.get(rounded) || 0) + line.text.length);
  }
  let bodyFontSize = 12;
  let maxCount = 0;
  for (const [size, count] of fontCounts) {
    if (count > maxCount) { maxCount = count; bodyFontSize = size; }
  }

  const paragraphs: string[] = [];
  let currentPara: string[] = [];
  let currentParaIsHeading = false;

  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const isHeading = Math.round(line.fontSize) > bodyFontSize + 1;
    const prevLine = i > 0 ? rawLines[i - 1] : null;

    let isParagraphBreak = false;
    if (prevLine) {
      const yGap = Math.abs(prevLine.y - line.y);
      const expectedLineGap = prevLine.fontSize * 1.4;
      isParagraphBreak = yGap > expectedLineGap * 1.5;
    }

    if (isHeading || isParagraphBreak || (prevLine && Math.abs(Math.round(prevLine.fontSize) - Math.round(line.fontSize)) > 1)) {
      if (currentPara.length > 0) {
        const text = currentPara.join(' ');
        paragraphs.push(currentParaIsHeading ? '\x04' + text : text);
        currentPara = [];
      }
      currentParaIsHeading = isHeading;
    }

    currentPara.push(line.text);
  }

  if (currentPara.length > 0) {
    const text = currentPara.join(' ');
    paragraphs.push(currentParaIsHeading ? '\x04' + text : text);
  }

  return paragraphs.join('\n\n');
}

/** Strip inline TOC from the beginning of the text if outline entries match */
function stripInlineToc(text: string, toc: TocEntry[]): string {
  const paragraphs = text.split(/\n\n/);
  // Only check first ~10% of paragraphs
  const checkLimit = Math.max(5, Math.ceil(paragraphs.length * 0.1));
  const tocTitles = new Set(toc.map(t => t.title.toLowerCase().trim()));

  let lastTocIndex = -1;
  for (let i = 0; i < Math.min(checkLimit, paragraphs.length); i++) {
    const cleaned = paragraphs[i].replace(/\x04/g, '').replace(/\d+\s*$/, '').trim().toLowerCase();
    if (cleaned && tocTitles.has(cleaned)) {
      lastTocIndex = i;
    }
  }

  // If we found a cluster of TOC matches at the start, remove them
  if (lastTocIndex >= 2) {
    // Check if at least 3 matches were found in the first chunk
    let matchCount = 0;
    for (let i = 0; i <= lastTocIndex; i++) {
      const cleaned = paragraphs[i].replace(/\x04/g, '').replace(/\d+\s*$/, '').trim().toLowerCase();
      if (cleaned && tocTitles.has(cleaned)) matchCount++;
    }
    if (matchCount >= 3) {
      return paragraphs.slice(lastTocIndex + 1).join('\n\n');
    }
  }

  return text;
}

async function extractPdfOutline(pdf: any): Promise<TocEntry[]> {
  const toc: TocEntry[] = [];
  try {
    const outline = await pdf.getOutline();
    if (!outline) return toc;

    const totalPages = pdf.numPages;

    async function walk(items: any[], level: number) {
      for (const item of items) {
        let pageNum = 1;
        try {
          if (item.dest) {
            const dest = typeof item.dest === 'string'
              ? await pdf.getDestination(item.dest)
              : item.dest;
            if (dest) {
              const ref = dest[0];
              const idx = await pdf.getPageIndex(ref);
              pageNum = idx + 1;
            }
          }
        } catch { /* fallback to page 1 */ }

        toc.push({
          title: item.title || 'Untitled',
          level,
          position: Math.max(0, Math.min(1, (pageNum - 1) / Math.max(1, totalPages - 1))),
        });

        if (item.items && item.items.length > 0) {
          await walk(item.items, level + 1);
        }
      }
    }

    await walk(outline, 0);
  } catch (err) {
    console.warn('[pdf] Failed to extract outline:', err);
  }
  return toc;
}
