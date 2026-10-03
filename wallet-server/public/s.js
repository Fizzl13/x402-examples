/* Fizzl visitor counter (fizzl.eu and its subdomains). Counts a page view and clicks to the Agent
   Wallet or a Fizzl service: no cookies, no storage, no IP address, nothing about you. Respects Do Not
   Track and Global Privacy Control. Details: https://wallet.fizzl.eu/privacy */
(function () {
  try {
    if (navigator.doNotTrack === "1" || window.doNotTrack === "1" || navigator.globalPrivacyControl) return;
    var END = "https://wallet.fizzl.eu/api/public/usage/site";
    var TARGETS = /^(wallet|ichimoku-signal|presign-guard|x402-doctor|plaintext)\.fizzl\.eu$/;
    var send = function (o) {
      var body = JSON.stringify(o);
      if (!(navigator.sendBeacon && navigator.sendBeacon(END, body))) fetch(END, { method: "POST", body: body, keepalive: true, mode: "cors" }).catch(function () {});
    };
    send({ kind: "view", path: location.pathname });
    var mark = function (e) {
      var a = e.target && e.target.closest && e.target.closest("a[href]");
      if (!a) return;
      var u; try { u = new URL(a.href, location.href); } catch (x) { return; }
      if (!TARGETS.test(u.hostname) || u.hostname === location.hostname) return;
      // Tell the wallet which Fizzl site the visitor came from (only the site's name).
      if (u.hostname === "wallet.fizzl.eu" && !u.searchParams.has("ref")) { u.searchParams.set("ref", location.hostname); a.href = u.href; }
      if (e.type === "click" || e.type === "auxclick") send({ kind: "out", path: location.pathname, to: u.hostname });
    };
    document.addEventListener("mousedown", mark, true);
    document.addEventListener("touchstart", mark, { capture: true, passive: true });
    document.addEventListener("click", mark, true);
    document.addEventListener("auxclick", mark, true);
  } catch (x) {}
})();
