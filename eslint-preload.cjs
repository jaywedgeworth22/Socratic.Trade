/* eslint-disable */
const Module = require('module');

const originalResolveFilename = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (request === 'typescript') {
    return originalResolveFilename.call(Module, 'typescript-v5', parent, isMain, options);
  }
  return originalResolveFilename.apply(Module, arguments);
};
