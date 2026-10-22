// Edit these before deploying.
window.APP_CONFIG = {
  // The Web app URL from Apps Script (Deploy → Manage deployments), ending in /exec.
  appsScriptUrl: 'https://script.google.com/macros/s/AKfycbyvCNNTL2OsPKl9sWwyiUdoHPCzvysUuVyX78J-VoyuB9iynhOLeDebENOIJrhb1KiD/exec',
  // Vercel function that reads screenshots with Gemini. Leave as is.
  extractUrl: '/api/extract',
  // A ticket whose destination matches any of these is "Coming to Malda", whose origin matches is "Going back".
  venueMatchers: ['MALDA', 'MLDT', 'OMLF'],
};
