'use strict';

var defineProperties = require('define-properties');
var isEnumerable = Object.prototype.propertyIsEnumerable;
var functionsHaveNames = require('functions-have-names')();
var callBind = require('call-bind');

var runTests = require('./tests');

module.exports = function (t) {
	t.equal(Promise['try'].length, 1, 'Promise.try has a length of 1');
	t.test('Function name', { skip: !functionsHaveNames }, function (st) {
		st.match(Promise['try'].name, /^try_?$/, 'Promise.try has name "try"');

		st.end();
	});

	t.test('enumerability', { skip: !defineProperties.supportsDescriptors }, function (et) {
		et.equal(false, isEnumerable.call(Promise, 'try'), 'Promise.try is not enumerable');

		et.end();
	});

	var supportsStrictMode = (function () { return typeof this === 'undefined'; }());

	t.test('bad object value', { skip: !supportsStrictMode }, function (st) {
		st['throws'](function () { return Promise['try'].call(undefined); }, TypeError, 'undefined is not an object');
		st['throws'](function () { return Promise['try'].call(null); }, TypeError, 'null is not an object');
		st.end();
	});

	var bound = callBind.apply(Promise['try']);
	var rebindable = function try_(callbackfn) { // eslint-disable-line no-unused-vars
		return bound(typeof this === 'undefined' ? Promise : this, arguments);
	};

	runTests(rebindable, t);
};
