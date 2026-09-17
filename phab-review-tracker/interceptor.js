// Injected into the page context (not the extension sandbox) so it can
// wrap XMLHttpRequest before Phabricator's Javelin code runs.
// Detects accept / request-changes POST calls and fires a CustomEvent
// that the content script (which shares the DOM) can hear.

(function () {
  'use strict';

  const REVIEW_PATTERNS = [
    /\/differential\/revision\/accept\//i,
    /\/differential\/revision\/request-changes\//i,
    /\/transactions\//i,   // catch the generic transaction endpoint too
  ];

  const ACTION_KEYWORDS = ['accept', 'requestChanges', 'request-changes', 'reject'];

  function looksLikeReviewAction(url, body) {
    if (REVIEW_PATTERNS.some(re => re.test(url))) return true;
    if (body && ACTION_KEYWORDS.some(k => body.includes(k))) return true;
    return false;
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._pratMethod = method;
    this._pratUrl = url;
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    const url  = this._pratUrl  || '';
    const meth = this._pratMethod || '';
    if (meth.toUpperCase() === 'POST' && looksLikeReviewAction(url, body)) {
      this.addEventListener('load', () => {
        if (this.status >= 200 && this.status < 300) {
          document.dispatchEvent(new CustomEvent('prat-review-action'));
        }
      });
    }
    return origSend.apply(this, arguments);
  };
})();
