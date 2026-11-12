import type { Logger } from '../../core/logging/Logger.ts';
import type { BrowserLauncher, InputParams, PageEvents, RemotePage } from './types.ts';
import { validateAndSanitizeUrl } from './urlSecurity.ts';

export const VIEWPORT_WIDTH = 1280;
export const VIEWPORT_HEIGHT = 720;
const NAVIGATION_TIMEOUT_MS = 30_000;

const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-background-networking',
  '--disable-default-apps',
  '--disable-extensions',
  '--disable-sync',
  '--mute-audio',
  `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`
];

const ignore = (): void => {};

/**
 * Headless Chrome through puppeteer-core (legacy browserHandler.js `createBrowserSession`).
 * puppeteer-core is imported on the first launch, so nothing is loaded or spawned before a
 * shared browser is actually started. Every navigation (redirects included) is re-checked
 * against SSRF; dialogs are dismissed; frames come from a CDP JPEG screencast.
 */
export class PuppeteerLauncher implements BrowserLauncher {
  readonly #ssrfLog: Logger;

  /** @param logger root logger; SSRF blocks are logged as `[SharedBrowser SSRF] ...` */
  constructor(logger: Logger) {
    this.#ssrfLog = logger.child('SharedBrowser SSRF');
  }

  async launch(executablePath: string, events: PageEvents): Promise<RemotePage> {
    const { default: puppeteer } = await import('puppeteer-core');
    const browser = await puppeteer.launch({
      executablePath,
      headless: true,
      defaultViewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT, deviceScaleFactor: 1 },
      args: CHROME_ARGS
    });
    const pages = await browser.pages();
    const page = pages[0] ?? await browser.newPage();
    await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      void (async () => {
        if (req.isNavigationRequest()) {
          const target = req.url();
          const check = await validateAndSanitizeUrl(target);
          if (!check.valid) {
            this.#ssrfLog.warn(`Blokkolt navigáció (${target}): ${check.reason}`);
            await req.abort('accessdenied').catch(ignore);
            return;
          }
        }
        await req.continue().catch(ignore);
      })();
    });
    page.on('dialog', (dialog) => { dialog.dismiss().catch(ignore); });

    const cdp = await page.createCDPSession();
    let closed = false;
    await cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: 70, maxWidth: VIEWPORT_WIDTH, maxHeight: VIEWPORT_HEIGHT, everyNthFrame: 1
    });
    cdp.on('Page.screencastFrame', (params) => {
      if (closed) return;
      // Acknowledge so CDP sends the next frame.
      cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(ignore);
      events.frame({ data: params.data, metadata: params.metadata });
    });
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) events.mainFrameNavigated(frame.url());
    });
    page.on('load', () => { events.loaded(); });
    browser.on('disconnected', () => { events.disconnected(); });

    // Client input is forwarded as legacy did (CDP validates it), hence the untyped send.
    const sendInput = cdp.send.bind(cdp) as (method: string, params: InputParams) => Promise<unknown>;
    const options = { waitUntil: 'domcontentloaded' as const };
    return {
      goto: async (url, timeoutMs = NAVIGATION_TIMEOUT_MS) => { await page.goto(url, { ...options, timeout: timeoutMs }); },
      goBack: async () => { await page.goBack(); },
      goForward: async () => { await page.goForward(); },
      reload: async () => { await page.reload(options); },
      url: () => page.url(),
      title: () => page.title(),
      dispatchMouseEvent: async (params) => { await sendInput('Input.dispatchMouseEvent', params); },
      dispatchKeyEvent: async (params) => { await sendInput('Input.dispatchKeyEvent', params); },
      insertText: async (text) => { await cdp.send('Input.insertText', { text }); },
      close: async () => {
        closed = true;
        await cdp.detach().catch(ignore);
        await page.close().catch(ignore);
        await browser.close().catch(ignore);
      }
    };
  }
}
