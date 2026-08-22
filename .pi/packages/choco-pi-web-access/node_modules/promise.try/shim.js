'use strict';

var requirePromise = require('./requirePromise');

var getPolyfill = require('./polyfill');
var define = require('define-properties');

module.exports = function shimPromiseTry() {
	requirePromise();

	var polyfill = getPolyfill();
	define(Promise, { 'try': polyfill }, {
		'try': function testTry() {
			return Promise['try'] !== polyfill;
		}
	});
	return polyfill;
};
