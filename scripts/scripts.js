/* eslint-disable import/no-cycle */
import { events } from '@dropins/tools/event-bus.js';
import { getCartDataFromCache } from '@dropins/storefront-cart/api.js';
import {
  buildBlock,
  createOptimizedPicture as libCreateOptimizedPicture,
  decorateBlocks,
  decorateButtons,
  decorateIcons,
  decorateSections,
  decorateTemplateAndTheme,
  loadFooter,
  loadHeader,
  getMetadata,
  loadScript,
  toCamelCase,
  toClassName,
  readBlockConfig,
  waitForFirstImage,
  loadSection,
  loadSections,
  loadCSS,
  sampleRUM,
} from './aem.js';
import { getProduct, getSkuFromUrl, trackHistory } from './commerce.js';
import initializeDropins from './dropins.js';
import { loadFragment } from '../blocks/fragment/fragment.js';

const AUDIENCES = {
  mobile: () => window.innerWidth < 600,
  desktop: () => window.innerWidth >= 600,
  // define your custom audiences here as needed
};

/**
 * Gets all the metadata elements that are in the given scope.
 * @param {String} scope The scope/prefix for the metadata
 * @returns an array of HTMLElement nodes that match the given scope
 */
export function getAllMetadata(scope) {
  return [...document.head.querySelectorAll(`meta[property^="${scope}:"],meta[name^="${scope}-"]`)]
    .reduce((res, meta) => {
      const id = toClassName(meta.name
        ? meta.name.substring(scope.length + 1)
        : meta.getAttribute('property').split(':')[1]);
      res[id] = meta.getAttribute('content');
      return res;
    }, {});
}

// Define an execution context
const pluginContext = {
  getAllMetadata,
  getMetadata,
  loadCSS,
  loadScript,
  sampleRUM,
  toCamelCase,
  toClassName,
};

/**
 * Builds hero block and prepends to main in a new section.
 * @param {Element} main The container element
 */
function buildHeroBlock(main) {
  const h1 = main.querySelector('h1');
  const picture = main.querySelector('picture');
  // eslint-disable-next-line no-bitwise
  if (h1 && picture && (h1.compareDocumentPosition(picture) & Node.DOCUMENT_POSITION_PRECEDING)) {
    const section = document.createElement('div');
    section.append(buildBlock('hero', { elems: [picture, h1] }));
    main.prepend(section);
  }
}

/**
 * load fonts.css and set a session storage flag
 */
async function loadFonts() {
  await loadCSS(`${window.hlx.codeBasePath}/styles/fonts.css`);
  try {
    if (!window.location.hostname.includes('localhost')) sessionStorage.setItem('fonts-loaded', 'true');
  } catch (e) {
    // do nothing
  }
}

function autolinkModals(element) {
  element.addEventListener('click', async (e) => {
    const origin = e.target.closest('a');

    if (origin && origin.href && origin.href.includes('/modals/')) {
      e.preventDefault();
      const { openModal } = await import(`${window.hlx.codeBasePath}/blocks/modal/modal.js`);
      openModal(origin.href);
    }
  });
}

/**
 * Builds all synthetic blocks in a container element.
 * @param {Element} main The container element
 */
function buildAutoBlocks(main) {
  try {
    buildHeroBlock(main);
  } catch (error) {
    // eslint-disable-next-line no-console
    console.error('Auto Blocking failed', error);
  }
}

/**
 * Decorate Columns Template to the main element.
 * @param {Element} main The container element
 */
function buildTemplateColumns(doc) {
  const columns = doc.querySelectorAll('main > div.section[data-column-width]');

  columns.forEach((column) => {
    const columnWidth = column.getAttribute('data-column-width');
    const gap = column.getAttribute('data-gap');

    if (columnWidth) {
      column.style.setProperty('--column-width', columnWidth);
      column.removeAttribute('data-column-width');
    }

    if (gap) {
      column.style.setProperty('--gap', `var(--spacing-${gap.toLocaleLowerCase()})`);
      column.removeAttribute('data-gap');
    }
  });
}

async function buildTemplateCart(doc) {
  const main = doc.querySelector('main');

  // load fragment for empty cart
  const emptyCartMeta = getMetadata('empty-cart');
  const emptyCartPath = emptyCartMeta ? new URL(emptyCartMeta, window.location).pathname : '/empty-cart';
  const emptyCartFragment = await loadFragment(emptyCartPath);

  // append emptyCartFragment next to main
  main.after(emptyCartFragment);

  const hasProducts = getCartDataFromCache()?.totalQuantity > 0 || false;

  // toggle view based on cart data
  function toggleView(next) {
    if (next) {
      emptyCartFragment.setAttribute('hidden', 'hidden');
      main.removeAttribute('hidden');
    } else {
      main.setAttribute('hidden', 'hidden');
      emptyCartFragment.removeAttribute('hidden');
    }
  }

  // initial state (cached)
  toggleView(hasProducts);

  // update state on cart data event
  let prev = hasProducts;

  events.on('cart/data', (payload) => {
    const next = payload?.totalQuantity > 0 || false;

    if (next !== prev) {
      prev = next;
      toggleView(next);
    }
  }, { eager: true });
}

async function applyTemplates(doc) {
  if (doc.body.classList.contains('columns')) {
    buildTemplateColumns(doc);
  }

  if (doc.body.classList.contains('cart')) {
    await buildTemplateCart(doc);
  }
}
/**
 * Gets the extension of a URL.
 * @param {string} url The URL
 * @returns {string} The extension
 * @private
 * @example
 * get_url_extension('https://example.com/foo.jpg');
 * // returns 'jpg'
 * get_url_extension('https://example.com/foo.jpg?bar=baz');
 * // returns 'jpg'
 * get_url_extension('https://example.com/foo');
 * // returns ''
 * get_url_extension('https://example.com/foo.jpg#qux');
 * // returns 'jpg'
 */
function getUrlExtension(url) {
  return url.split(/[#?]/)[0].split('.').pop().trim();
}
/**
 * Checks if an element is an external image.
 * @param {Element} element The element
 * @param {string} externalImageMarker The marker for external images
 * @returns {boolean} Whether the element is an external image
 * @private
 */
function isExternalImage(element, externalImageMarker) {
  // if the element is not an anchor, it's not an external image
  if (element.tagName !== 'A') return false;
  // if the element is an anchor with the external image marker as text content,
  // it's an external image
  if (element.textContent.trim() === externalImageMarker) {
    return true;
  }
  // if the element is an anchor with the href as text content and the href has
  // an image extension, it's an external image
  if (element.textContent.trim() === element.getAttribute('href')) {
    const ext = getUrlExtension(element.getAttribute('href'));
    return ext && ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext.toLowerCase());
  }
  return false;
}
/*
  * Appends query params to a URL
  * @param {string} url The URL to append query params to
  * @param {object} params The query params to append
  * @returns {string} The URL with query params appended
  * @private
  * @example
  * appendQueryParams('https://example.com', { foo: 'bar' });
  * // returns 'https://example.com?foo=bar'
*/
function appendQueryParams(url, params) {
  const { searchParams } = url;
  params.forEach((value, key) => {
    searchParams.set(key, value);
  });
  url.search = searchParams.toString();
  return url.toString();
}
/**
 * Creates an optimized picture element for an image.
 * If the image is not an absolute URL, it will be passed to libCreateOptimizedPicture.
 * @param {string} src The image source URL
 * @param {string} alt The image alt text
 * @param {boolean} eager Whether to load the image eagerly
 * @param {object[]} breakpoints The breakpoints to use
 * @returns {Element} The picture element
 *
 */
export function createOptimizedPicture(src, alt = '', eager = false, breakpoints = [{ media: '(min-width: 600px)', width: '2000' }, { width: '750' }]) {
  const isAbsoluteUrl = /^https?:\/\//i.test(src);
  // Fallback to createOptimizedPicture if src is not an absolute URL
  if (!isAbsoluteUrl) return libCreateOptimizedPicture(src, alt, eager, breakpoints);
  const url = new URL(src);
  const picture = document.createElement('picture');
  const { pathname } = url;
  const ext = pathname.substring(pathname.lastIndexOf('.') + 1);
  // webp
  breakpoints.forEach((br) => {
    const source = document.createElement('source');
    if (br.media) source.setAttribute('media', br.media);
    source.setAttribute('type', 'image/webp');
    const searchParams = new URLSearchParams({ width: br.width, format: 'webply' });
    source.setAttribute('srcset', appendQueryParams(url, searchParams));
    picture.appendChild(source);
  });
  // fallback
  breakpoints.forEach((br, i) => {
    const searchParams = new URLSearchParams({ width: br.width, format: ext });
    if (i < breakpoints.length - 1) {
      const source = document.createElement('source');
      if (br.media) source.setAttribute('media', br.media);
      source.setAttribute('srcset', appendQueryParams(url, searchParams));
      picture.appendChild(source);
    } else {
      const img = document.createElement('img');
      img.setAttribute('loading', eager ? 'eager' : 'lazy');
      img.setAttribute('alt', alt);
      picture.appendChild(img);
      img.setAttribute('src', appendQueryParams(url, searchParams));
    }
  });
  return picture;
}
/*
  * Decorates external images with a picture element
  * @param {Element} ele The element
  * @param {string} deliveryMarker The marker for external images
  * @private
  * @example
  * decorateExternalImages(main, '//External Image//');
  */
function decorateExternalImages(ele, deliveryMarker) {
  const extImages = ele.querySelectorAll('a');
  extImages.forEach((extImage) => {
    if (isExternalImage(extImage, deliveryMarker)) {
      const extImageSrc = extImage.getAttribute('href');
      const extPicture = createOptimizedPicture(extImageSrc);
      /* copy query params from link to img */
      const extImageUrl = new URL(extImageSrc);
      const { searchParams } = extImageUrl;
      extPicture.querySelectorAll('source, img').forEach((child) => {
        if (child.tagName === 'SOURCE') {
          const srcset = child.getAttribute('srcset');
          if (srcset) {
            child.setAttribute('srcset', appendQueryParams(new URL(srcset, extImageSrc), searchParams));
          }
        } else if (child.tagName === 'IMG') {
          const src = child.getAttribute('src');
          if (src) {
            child.setAttribute('src', appendQueryParams(new URL(src, extImageSrc), searchParams));
          }
        }
      });
      extImage.parentNode.replaceChild(extPicture, extImage);
    }
  });
}

/**
 * Decorates the main element.
 * @param {Element} main The main element
 */
// eslint-disable-next-line import/prefer-default-export
export function decorateMain(main) {
  decorateExternalImages(main);
  // decorate external images with explicit external image marker
  decorateExternalImages(main, '//External Image//');
  // hopefully forward compatible button decoration
  decorateButtons(main);
  decorateIcons(main);
  buildAutoBlocks(main);
  decorateSections(main);
  decorateBlocks(main);
}

function preloadFile(href, as) {
  const link = document.createElement('link');
  link.rel = 'preload';
  link.as = as;
  link.crossOrigin = 'anonymous';
  link.href = href;
  document.head.appendChild(link);
}

/**
 * Loads everything needed to get to LCP.
 * @param {Element} doc The container element
 */
async function loadEager(doc) {
  document.documentElement.lang = 'en';
  await initializeDropins();
  decorateTemplateAndTheme();

  // Instrument experimentation plugin
  if (getMetadata('experiment')
    || Object.keys(getAllMetadata('campaign')).length
    || Object.keys(getAllMetadata('audience')).length) {
    // eslint-disable-next-line import/no-relative-packages
    const { loadEager: runEager } = await import('../plugins/experimentation/src/index.js');
    await runEager(document, { audiences: AUDIENCES }, pluginContext);
  }

  window.adobeDataLayer = window.adobeDataLayer || [];

  let pageType = 'CMS';
  if (document.body.querySelector('main .product-details')) {
    pageType = 'Product';
    const sku = getSkuFromUrl();
    window.getProductPromise = getProduct(sku);

    preloadFile('/scripts/__dropins__/storefront-pdp/containers/ProductDetails.js', 'script');
    preloadFile('/scripts/__dropins__/storefront-pdp/api.js', 'script');
    preloadFile('/scripts/__dropins__/storefront-pdp/render.js', 'script');
    preloadFile('/scripts/__dropins__/storefront-pdp/chunks/initialize.js', 'script');
    preloadFile('/scripts/__dropins__/storefront-pdp/chunks/getRefinedProduct.js', 'script');
  } else if (document.body.querySelector('main .product-details-custom')) {
    pageType = 'Product';
    preloadFile('/scripts/preact.js', 'script');
    preloadFile('/scripts/htm.js', 'script');
    preloadFile('/blocks/product-details-custom/ProductDetailsCarousel.js', 'script');
    preloadFile('/blocks/product-details-custom/ProductDetailsSidebar.js', 'script');
    preloadFile('/blocks/product-details-custom/ProductDetailsShimmer.js', 'script');
    preloadFile('/blocks/product-details-custom/Icon.js', 'script');

    const blockConfig = readBlockConfig(document.body.querySelector('main .product-details-custom'));
    const sku = getSkuFromUrl() || blockConfig.sku;
    window.getProductPromise = getProduct(sku);
  } else if (document.body.querySelector('main .product-list-page')) {
    pageType = 'Category';
    preloadFile('/scripts/widgets/search.js', 'script');
  } else if (document.body.querySelector('main .product-list-page-custom')) {
    // TODO Remove this bracket if not using custom PLP
    pageType = 'Category';
    const plpBlock = document.body.querySelector('main .product-list-page-custom');
    const { category, urlpath } = readBlockConfig(plpBlock);

    if (category && urlpath) {
      // eslint-disable-next-line import/no-unresolved, import/no-absolute-path
      const { preloadCategory } = await import('/blocks/product-list-page-custom/product-list-page-custom.js');
      preloadCategory({ id: category, urlPath: urlpath });
    }
  } else if (document.body.querySelector('main .commerce-cart')) {
    pageType = 'Cart';
  } else if (document.body.querySelector('main .commerce-checkout')) {
    pageType = 'Checkout';
  }

  window.adobeDataLayer.push({
    pageContext: {
      pageType,
      pageName: document.title,
      eventType: 'visibilityHidden',
      maxXOffset: 0,
      maxYOffset: 0,
      minXOffset: 0,
      minYOffset: 0,
    },
    shoppingCartContext: {
      totalQuantity: 0,
    },
  });
  if (pageType !== 'Product') {
    window.adobeDataLayer.push((dl) => {
      dl.push({ event: 'page-view', eventInfo: { ...dl.getState() } });
    });
  }

  const main = doc.querySelector('main');
  if (main) {
    // Main Decorations
    decorateMain(main);

    // Template Decorations
    await applyTemplates(doc);

    // Load LCP blocks
    document.body.classList.add('appear');
    await loadSection(main.querySelector('.section'), waitForFirstImage);
  }

  events.emit('eds/lcp', true);

  sampleRUM.enhance();

  try {
    /* if desktop (proxy for fast connection) or fonts already loaded, load fonts.css */
    if (window.innerWidth >= 900 || sessionStorage.getItem('fonts-loaded')) {
      loadFonts();
    }
  } catch (e) {
    // do nothing
  }
}

/**
 * Loads everything that doesn't need to be delayed.
 * @param {Element} doc The container element
 */
async function loadLazy(doc) {
  autolinkModals(doc);

  const main = doc.querySelector('main');
  await loadSections(main);

  const { hash } = window.location;
  const element = hash ? doc.getElementById(hash.substring(1)) : false;
  if (hash && element) element.scrollIntoView();

  await Promise.all([
    loadHeader(doc.querySelector('header')),
    loadFooter(doc.querySelector('footer')),
    loadCSS(`${window.hlx.codeBasePath}/styles/lazy-styles.css`),
    loadFonts(),
    import('./acdl/adobe-client-data-layer.min.js'),
  ]);

  if (sessionStorage.getItem('acdl:debug')) {
    import('./acdl/validate.js');
  }

  trackHistory();

  // Implement experimentation preview pill
  if ((getMetadata('experiment')
    || Object.keys(getAllMetadata('campaign')).length
    || Object.keys(getAllMetadata('audience')).length)) {
    // eslint-disable-next-line import/no-relative-packages
    const { loadLazy: runLazy } = await import('../plugins/experimentation/src/index.js');
    await runLazy(document, { audiences: AUDIENCES }, pluginContext);
  }
  loadCSS(`${window.hlx.codeBasePath}/styles/lazy-styles.css`);
  loadFonts();
}

/**
 * Loads everything that happens a lot later,
 * without impacting the user experience.
 */
function loadDelayed() {
  window.setTimeout(() => import('./delayed.js'), 3000);
  // load anything that can be postponed to the latest here
}

export async function fetchIndex(indexFile, pageSize = 500) {
  const handleIndex = async (offset) => {
    const resp = await fetch(`/${indexFile}.json?limit=${pageSize}&offset=${offset}`);
    const json = await resp.json();

    const newIndex = {
      complete: (json.limit + json.offset) === json.total,
      offset: json.offset + pageSize,
      promise: null,
      data: [...window.index[indexFile].data, ...json.data],
    };

    return newIndex;
  };

  window.index = window.index || {};
  window.index[indexFile] = window.index[indexFile] || {
    data: [],
    offset: 0,
    complete: false,
    promise: null,
  };

  // Return index if already loaded
  if (window.index[indexFile].complete) {
    return window.index[indexFile];
  }

  // Return promise if index is currently loading
  if (window.index[indexFile].promise) {
    return window.index[indexFile].promise;
  }

  window.index[indexFile].promise = handleIndex(window.index[indexFile].offset);
  const newIndex = await (window.index[indexFile].promise);
  window.index[indexFile] = newIndex;

  return newIndex;
}

/**
 * Check if consent was given for a specific topic.
 * @param {*} topic Topic identifier
 * @returns {boolean} True if consent was given
 */
// eslint-disable-next-line no-unused-vars
export function getConsent(topic) {
  console.warn('getConsent not implemented');
  return true;
}

async function loadPage() {
  await loadEager(document);
  await loadLazy(document);
  loadDelayed();
}

loadPage();
