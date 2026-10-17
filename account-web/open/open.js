// App Link fallback: when the app didn't open the link directly, offer an Android intent to the
// same path (Chrome opens the app, or the Play listing if it isn't installed).
(function () {
  var play = 'https://play.google.com/store/apps/details?id=com.zombitstudios.alwaysontime';
  var path = location.pathname + location.search;
  if (!/^\/open\/[A-Za-z0-9_\/-]*(\?source=assistant)?$/.test(path)) path = '/open/';
  var intent = 'intent://' + location.host + path + '#Intent;scheme=https;package=com.zombitstudios.alwaysontime;' +
    'S.browser_fallback_url=' + encodeURIComponent(play) + ';end';
  if (/Android/i.test(navigator.userAgent)) document.getElementById('open').href = intent;
})();
