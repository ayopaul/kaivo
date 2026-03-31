import * as pdfjsLib from 'pdfjs-dist';

pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

export interface PageImage {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

export interface TocEntry {
  title: string;
  level: number;
  position: number; // 0–1 fraction of total content
}

export interface BookData {
  title: string;
  pageImages: PageImage[];
  allText: string; // may contain link markers: \x01url\x02text\x03
  toc: TocEntry[];
  fileType: 'pdf' | 'epub';
}

/** Detect if we're on a mobile/low-memory device */
function isMobile(): boolean {
  return /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
    (navigator.maxTouchPoints > 1 && window.innerWidth < 1024);
}

export async function extractPdf(
  file: File,
  onProgress?: (current: number, total: number) => void
): Promise<BookData> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const pageImages: PageImage[] = [];
  const textParts: string[] = [];
  const mobile = isMobile();
  const renderScale = mobile ? 1 : 1.5;
  const totalPages = pdf.numPages;

  for (let i = 1; i <= totalPages; i++) {
    onProgress?.(i, totalPages);

    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: renderScale });

    const offscreen = document.createElement('canvas');
    offscreen.width = viewport.width;
    offscreen.height = viewport.height;
    const offCtx = offscreen.getContext('2d')!;

    await page.render({ canvasContext: offCtx, viewport, canvas: offscreen } as any).promise;

    // Apply greyscale using canvas filter (GPU-accelerated, no pixel loop)
    offCtx.filter = 'grayscale(1)';
    offCtx.drawImage(offscreen, 0, 0);
    offCtx.filter = 'none';

    pageImages.push({
      canvas: offscreen,
      width: viewport.width,
      height: viewport.height,
    });

    // Extract embedded text
    const content = await page.getTextContent();
    const text = content.items
      .map((item: any) => item.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) textParts.push(text);

    // Yield to event loop every few pages to prevent UI freeze
    if (i % 3 === 0) {
      await new Promise(r => setTimeout(r, 0));
    }
  }

  // Extract TOC from PDF outline
  const toc = await extractPdfOutline(pdf);

  const title = file.name.replace(/\.pdf$/i, '');
  return { title, pageImages, allText: textParts.join('\n\n'), toc, fileType: 'pdf' };
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
