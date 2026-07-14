/* eslint-disable */
const Module = require('module');

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'typescript') {
    return originalResolveFilename.call(Module, 'typescript-v5', parent, isMain, options);
  }
  if (request.includes('/node_modules/typescript/')) {
    const redirected = request.replace('/node_modules/typescript/', '/node_modules/typescript-v5/');
    return originalResolveFilename.call(Module, redirected, parent, isMain, options);
  }
  return originalResolveFilename.apply(Module, arguments);
};
