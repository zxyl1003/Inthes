var scope;
async function startup({ rootURI }, reason) {
  await Zotero.initializationPromise;
  const win = Zotero.getMainWindow();
  scope = { Zotero, Services, ChromeUtils, IOUtils, PathUtils, Cc, Ci, console: win.console,
    URL: win.URL, Blob: win.Blob, Worker: win.Worker, DOMException: win.DOMException, AbortController: win.AbortController,
    TextDecoder: win.TextDecoder, TextEncoder: win.TextEncoder, crypto: win.crypto,
    atob: win.atob.bind(win), btoa: win.btoa.bind(win),
    setTimeout: win.setTimeout.bind(win), clearTimeout: win.clearTimeout.bind(win),
    structuredClone: win.structuredClone.bind(win) };
  Services.scriptloader.loadSubScriptWithOptions(rootURI + 'folio.js', { target: scope, ignoreCache: true });
  await scope.Folio.start();
}
function shutdown(data, reason) {
  if (scope) { scope.Folio.stop(); scope = null; }
}
function install() {}
function uninstall() {}
function onMainWindowLoad({ window }) { if (scope) scope.Folio.attach(window); }
function onMainWindowUnload({ window }) { if (scope) scope.Folio.detach(window); }
