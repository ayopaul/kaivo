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

export async function extractPdf(file: File): Promise<BookData> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const pageImages: PageImage[] = [];
  const textParts: string[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2 });

    // Render page to offscreen canvas
    const offscreen = document.createElement('canvas');
    offscreen.width = viewport.width;
    offscreen.height = viewport.height;
    const offCtx = offscreen.getContext('2d')!;

    await page.render({ canvasContext: offCtx, viewport, canvas: offscreen } as any).promise;

    // Apply greyscale filter
    offCtx.filter = 'grayscale(100%)';
    offCtx.drawImage(offscreen, 0, 0);
    const imageData = offCtx.getImageData(0, 0, offscreen.width, offscreen.height);
    const data = imageData.data;
    for (let j = 0; j < data.length; j += 4) {
      const avg = data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114;
      data[j] = avg;
      data[j + 1] = avg;
      data[j + 2] = avg;
    }
    offCtx.putImageData(imageData, 0, 0);

    pageImages.push({
      canvas: offscreen,
      width: viewport.width,
      height: viewport.height,
    });

    // Extract text
    const content = await page.getTextContent();
    const text = content.items
      .map((item: any) => item.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) textParts.push(text);
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
