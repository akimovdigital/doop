const { contextBridge } = require('electron')

// Stacki Studio's page-address host lets an embedding application choose its initial page.
if (location.origin === 'http://127.0.0.1:48672' && location.pathname === '/studio') {
  const file = new URLSearchParams(location.search).get('file')
  if (/^src\/pages\/example-[1-9]\d*\.astro$/.test(file ?? '')) {
    contextBridge.exposeInMainWorld('__stackiPageAddress', {
      initialFile: () => file,
      opened: () => {},
      listen: () => () => {},
      leave: () => false,
    })
  }
}
