// App Link and Universal Link fallback, shown when the app didn't open the link directly.
// Android: offer an intent to the same path (Chrome opens the app, or the Play listing if it isn't
// installed). iPhone: there is no App Store listing yet, so say to open the link on the iPhone with
// the app, and point the button at the same path on the other associated domain: iOS keeps a tap
// on a same-domain link in the browser, but opens the app for one to another associated domain.
(function () {
  var play = 'https://play.google.com/store/apps/details?id=com.zombitstudios.alwaysontime';
  var hosts = ['alwaysontime.zombit.io', 'always-on-time-zombit-2026.web.app'];
  var path = location.pathname + location.search;
  if (!/^\/open\/[A-Za-z0-9_\/-]*(\?source=assistant)?$/.test(path)) path = '/open/';
  var open = document.getElementById('open');
  var agent = navigator.userAgent;
  if (/iPhone|iPad|iPod/i.test(agent)) {
    var other = location.host === hosts[0] ? hosts[1] : hosts[0];
    open.href = 'https://' + other + path;
    document.getElementById('app-page').href = 'https://zombit.io/always-on-time/';
    var sections = document.querySelectorAll('[data-platform]');
    for (var i = 0; i < sections.length; i++) {
      sections[i].hidden = sections[i].getAttribute('data-platform') !== 'ios';
    }
  } else if (/Android/i.test(agent)) {
    open.href = 'intent://' + location.host + path + '#Intent;scheme=https;package=com.zombitstudios.alwaysontime;' +
      'S.browser_fallback_url=' + encodeURIComponent(play) + ';end';
  }
})();
