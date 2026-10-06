// Stamps the stored theme before anything paints, so a viewer who chose dark
// does not get a frame of white on every load. A file rather than an inline
// <script>: the server's content security policy runs scripts from this site
// only, and it blocked the inline one in production, so the fix never ran.
try {
  var t = localStorage.getItem('theme');
  document.documentElement.setAttribute('data-theme', t === 'dark' ? 'dark' : 'light');
} catch (e) { document.documentElement.setAttribute('data-theme', 'light'); }
