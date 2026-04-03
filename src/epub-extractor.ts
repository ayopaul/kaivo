import JSZip from 'jszip';
import { BookData, TocEntry } from './pdf-extractor';

export async function extractEpub(file: File): Promise<BookData> {
  const arrayBuffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(arrayBuffer);

  // 1. Find the OPF file path from META-INF/container.xml
  const containerXml = await zip.file('META-INF/container.xml')?.async('text');
  if (!containerXml) throw new Error('Invalid EPUB: no container.xml');

  const containerDoc = new DOMParser().parseFromString(containerXml, 'application/xml');
  const rootfilePath = containerDoc.querySelector('rootfile')?.getAttribute('full-path');
  if (!rootfilePath) throw new Error('Invalid EPUB: no rootfile path');

  // 2. Parse the OPF to get metadata and spine order
  const opfXml = await zip.file(rootfilePath)?.async('text');
  if (!opfXml) throw new Error('Invalid EPUB: cannot read OPF');

  const opfDoc = new DOMParser().parseFromString(opfXml, 'application/xml');
  const opfDir = rootfilePath.includes('/') ? rootfilePath.substring(0, rootfilePath.lastIndexOf('/') + 1) : '';

  // Get title
  const titleEl = opfDoc.querySelector('metadata title') ?? opfDoc.getElementsByTagNameNS('http://purl.org/dc/elements/1.1/', 'title')[0];
  const title = titleEl?.textContent?.trim() || file.name.replace(/\.epub$/i, '');

  // Build manifest map: id -> href
  const manifest = new Map<string, string>();
  opfDoc.querySelectorAll('manifest item').forEach((item) => {
    const id = item.getAttribute('id');
    const href = item.getAttribute('href');
    if (id && href) manifest.set(id, href);
  });

  // Get spine order (list of itemref idrefs)
  const spineRefs: string[] = [];
  opfDoc.querySelectorAll('spine itemref').forEach((ref) => {
    const idref = ref.getAttribute('idref');
    if (idref) spineRefs.push(idref);
  });

  // 3. Read each spine item and extract text + links
  const textParts: string[] = [];
  // Track cumulative character offsets for each spine item (for TOC mapping)
  const spineOffsets = new Map<string, number>(); // href -> char offset in final text
  let cumulativeLength = 0;

  for (const idref of spineRefs) {
    const href = manifest.get(idref);
    if (!href) continue;

    const fullPath = opfDir + href;
    const content = await zip.file(fullPath)?.async('text');
    if (!content) continue;

    // Record offset for this spine item (use the href without directory)
    spineOffsets.set(href, cumulativeLength);
    // Also store with full path for matching
    spineOffsets.set(fullPath, cumulativeLength);

    const doc = new DOMParser().parseFromString(content, 'application/xhtml+xml');
    const body = doc.querySelector('body');
    if (!body) continue;

    const text = extractTextFromElement(body);
    if (text.trim()) {
      textParts.push(text.trim());
      // +5 for the \n\n\x05\n\n join separator
      cumulativeLength += text.trim().length + 5;
    }
  }

  const allText = textParts.join('\n\n\x05\n\n');
  const totalLength = allText.length;

  // 4. Extract TOC
  const toc = await extractEpubToc(zip, opfDoc, opfDir, spineOffsets, totalLength);

  return { title, pageImages: [], allText, toc, fileType: 'epub' };
}

/** Extract TOC from NCX or NAV document */
async function extractEpubToc(
  zip: JSZip,
  opfDoc: Document,
  opfDir: string,
  spineOffsets: Map<string, number>,
  totalLength: number
): Promise<TocEntry[]> {
  const toc: TocEntry[] = [];

  // Try EPUB3 NAV first
  const navItem = opfDoc.querySelector('manifest item[properties~="nav"]');
  if (navItem) {
    const navHref = navItem.getAttribute('href');
    if (navHref) {
      const navPath = opfDir + navHref;
      const navXml = await zip.file(navPath)?.async('text');
      if (navXml) {
        const navDoc = new DOMParser().parseFromString(navXml, 'application/xhtml+xml');
        // Find the <nav> element with epub:type="toc"
        const navEl = navDoc.querySelector('nav[*|type="toc"]') ??
          navDoc.querySelector('nav');
        if (navEl) {
          parseNavList(navEl, 0, toc, opfDir, spineOffsets, totalLength);
          if (toc.length > 0) return toc;
        }
      }
    }
  }

  // Fall back to NCX (EPUB2)
  const ncxItem = Array.from(opfDoc.querySelectorAll('manifest item')).find(
    item => item.getAttribute('media-type') === 'application/x-dtbncx+xml'
  );
  if (ncxItem) {
    const ncxHref = ncxItem.getAttribute('href');
    if (ncxHref) {
      const ncxPath = opfDir + ncxHref;
      const ncxXml = await zip.file(ncxPath)?.async('text');
      if (ncxXml) {
        const ncxDoc = new DOMParser().parseFromString(ncxXml, 'application/xml');
        const navMap = ncxDoc.querySelector('navMap');
        if (navMap) {
          parseNcxNavPoints(navMap, 0, toc, opfDir, spineOffsets, totalLength);
        }
      }
    }
  }

  return toc;
}

function parseNavList(
  nav: Element,
  level: number,
  toc: TocEntry[],
  opfDir: string,
  spineOffsets: Map<string, number>,
  totalLength: number
) {
  const ol = nav.querySelector(':scope > ol');
  if (!ol) return;

  for (const li of Array.from(ol.querySelectorAll(':scope > li'))) {
    const a = li.querySelector(':scope > a');
    if (a) {
      const title = (a.textContent || '').trim();
      const href = a.getAttribute('href') || '';
      const baseHref = href.split('#')[0];

      const position = resolvePosition(baseHref, opfDir, spineOffsets, totalLength);

      if (title) {
        toc.push({ title, level, position });
      }
    }

    // Recurse into nested <ol>
    const nestedOl = li.querySelector(':scope > ol');
    if (nestedOl) {
      const tempNav = document.createElement('nav');
      tempNav.appendChild(nestedOl.cloneNode(true));
      parseNavList(tempNav, level + 1, toc, opfDir, spineOffsets, totalLength);
    }
  }
}

function parseNcxNavPoints(
  parent: Element,
  level: number,
  toc: TocEntry[],
  opfDir: string,
  spineOffsets: Map<string, number>,
  totalLength: number
) {
  const navPoints = parent.querySelectorAll(':scope > navPoint');
  for (const np of Array.from(navPoints)) {
    const label = np.querySelector('navLabel text')?.textContent?.trim() || '';
    const contentSrc = np.querySelector('content')?.getAttribute('src') || '';
    const baseHref = contentSrc.split('#')[0];

    const position = resolvePosition(baseHref, opfDir, spineOffsets, totalLength);

    if (label) {
      toc.push({ title: label, level, position });
    }

    // Recurse
    parseNcxNavPoints(np, level + 1, toc, opfDir, spineOffsets, totalLength);
  }
}

function resolvePosition(
  href: string,
  opfDir: string,
  spineOffsets: Map<string, number>,
  totalLength: number
): number {
  if (totalLength <= 0) return 0;

  // Try direct href
  let offset = spineOffsets.get(href);
  if (offset !== undefined) return offset / totalLength;

  // Try with opfDir prefix
  offset = spineOffsets.get(opfDir + href);
  if (offset !== undefined) return offset / totalLength;

  // Try matching just the filename
  const filename = href.split('/').pop() || '';
  for (const [key, val] of spineOffsets.entries()) {
    if (key.endsWith('/' + filename) || key === filename) {
      return val / totalLength;
    }
  }

  return 0;
}

/** Walk DOM nodes and preserve paragraph/heading/list structure, embed link markers */
function extractTextFromElement(el: Element | Node): string {
  if (!el || !el.childNodes) return '';

  const parts: string[] = [];

  const blockTags = new Set([
    'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6',
    'LI', 'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'HEADER',
    'FOOTER', 'ASIDE', 'TR', 'DT', 'DD', 'FIGCAPTION',
  ]);

  const breakTags = new Set(['BR', 'HR']);

  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3) {
      const text = (child.textContent || '').replace(/\s+/g, ' ');
      if (text.trim()) parts.push(text);
    } else if (child.nodeType === 1) {
      const tag = (child as Element).tagName?.toUpperCase();
      if (!tag) continue;

      if (breakTags.has(tag)) {
        parts.push('\n');
        continue;
      }

      // Handle links — embed markers for external URLs
      if (tag === 'A') {
        const href = (child as Element).getAttribute('href') || '';
        if (href.startsWith('http://') || href.startsWith('https://')) {
          const linkText = extractPlainText(child as Element);
          if (linkText.trim()) {
            parts.push(`\x01${href}\x02${linkText.trim()}\x03`);
            continue;
          }
        }
      }

      const innerText = extractTextFromElement(child as Element);
      if (!innerText.trim()) continue;

      if (blockTags.has(tag)) {
        parts.push('\n\n' + innerText.trim());
      } else {
        parts.push(innerText);
      }
    }
  }

  return parts.join('');
}

/** Extract plain text only (no link markers), for use inside link elements */
function extractPlainText(el: Element): string {
  return (el.textContent || '').replace(/\s+/g, ' ').trim();
}
