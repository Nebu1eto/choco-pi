'use strict';

var callBind = require('call-bind');
var define = require('define-properties');

var implementation = require('./implementation');
var getPolyfill = require('./polyfill');
var shim = require('./shim');

var requirePromise = require('./requirePromise');

var bound = callBind.apply(getPolyfill());

var promiseTry = function promiseTry(fn) { // eslint-disable-line no-unused-vars
	requirePromise();

	return bound(typeof this === 'undefined' ? Promise : this, arguments);
};

define(promiseTry, {
	getPolyfill: getPolyfill,
	implementation: implementation,
	shim: shim
});

module.exports = promiseTry;
