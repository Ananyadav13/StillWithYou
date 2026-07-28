/* Paste this into the DevTools console on web.whatsapp.com WITH A CHAT OPEN.
 *
 * It answers the one question no local test can: do the selectors in selectors.js still
 * match today's real WhatsApp DOM? The fixture harness proves the extension's own logic
 * against a *recorded* copy of that DOM, and a recording goes stale exactly as the
 * selectors do — so this is the only way to check the recording is still accurate.
 *
 * It reads the DOM and prints. It changes nothing, clicks nothing, and sends nothing.
 * No message content is read or printed — only element structure and attribute names.
 */

(() => {
  const CHAIN = [
    'footer div[contenteditable="true"][data-tab="10"]',
    '#main footer div[contenteditable="true"]',
    'footer div[role="textbox"][contenteditable="true"]',
    'div[role="textbox"][contenteditable="true"]',
  ];

  const SEND_CHAIN = [
    'button[aria-label="Send"]',
    'footer button[data-tab="11"]',
    'span[data-icon="send"]',
    'footer button[aria-label]',
  ];

  console.log('%c--- StillWithYou selector diagnostic ---', 'font-weight:bold');
  console.log('conversation open?', Boolean(document.querySelector('#main')));
  console.log('');

  const report = (label, chain) => {
    console.log(`%c${label}`, 'font-weight:bold');
    chain.forEach((sel, i) => {
      let hit = null;
      try {
        hit = document.querySelector(sel);
      } catch (e) {
        console.log(`  [${i}] MALFORMED  ${sel}`);
        return;
      }
      console.log(`  [${i}] ${hit ? 'MATCH  ' : 'no     '} ${sel}`);
    });
    console.log('');
  };

  report('composeBox chain', CHAIN);
  report('sendButton chain', SEND_CHAIN);

  /* Every editable element on the page, with its full attribute set. This is what a new
   * selector chain gets written from — attribute NAMES and VALUES only, never content. */
  const editables = [...document.querySelectorAll('[contenteditable="true"]')].map((el) => ({
    tag: el.tagName.toLowerCase(),
    attrs: Object.fromEntries([...el.attributes].map((a) => [a.name, a.value])),
    inFooter: Boolean(el.closest('footer')),
    inMain: Boolean(el.closest('#main')),
    parentTags: (() => {
      const out = [];
      let p = el.parentElement;
      for (let i = 0; i < 4 && p; i += 1, p = p.parentElement) {
        out.push(p.tagName.toLowerCase() + (p.id ? `#${p.id}` : ''));
      }
      return out.join(' < ');
    })(),
    size: (() => {
      const r = el.getBoundingClientRect();
      return `${Math.round(r.width)}x${Math.round(r.height)}`;
    })(),
  }));

  console.log('%ccontenteditable elements found:', 'font-weight:bold', editables.length);
  console.table(editables.map((e) => ({
    tag: e.tag,
    'data-tab': e.attrs['data-tab'] ?? '',
    role: e.attrs.role ?? '',
    'aria-label': e.attrs['aria-label'] ?? '',
    inFooter: e.inFooter,
    inMain: e.inMain,
    size: e.size,
  })));
  console.log('full attribute dump:', editables);

  /* Footer buttons, for the send-button canary. */
  const buttons = [...document.querySelectorAll('footer button')].map((b) => ({
    'aria-label': b.getAttribute('aria-label') ?? '',
    'data-tab': b.getAttribute('data-tab') ?? '',
    icon: b.querySelector('[data-icon]')?.getAttribute('data-icon') ?? '',
  }));
  console.log('%cfooter buttons:', 'font-weight:bold');
  console.table(buttons);

  console.log('%cCopy the two tables above back to continue.', 'font-weight:bold');
})();
