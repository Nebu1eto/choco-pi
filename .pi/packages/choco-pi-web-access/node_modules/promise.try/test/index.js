'use strict';

var index = require('../');
var test = require('tape');
var runTests = require('./tests');

test('as a function (index)', function (t) {
	t.test('bad Promise/this value', function (st) {
		// below test is skipped, because for convenience, i'm explicitly turning `undefined` into `Promise` in the main export

		// st['throws'](function () { index.call(undefined); }, TypeError, 'undefined is not an object');

		// eslint-disable-next-line no-useless-call
		st['throws'](function () { index.call(null); }, TypeError, 'null is not an object');

		st.end();
	});

	runTests(index, t);

	t.end();
});
