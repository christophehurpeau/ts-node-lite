import { ctxTsNode } from './helpers';
import { context, expect } from './testlib';

const test = context(ctxTsNode);

test.suite('create', ({ contextEach }) => {
  const test = contextEach(async (t) => {
    return {
      service: t.context.tsNodeUnderTest.create({
        compilerOptions: { target: 'es5' },
        skipProject: true,
      }),
    };
  });

  test('should create generic compiler instances', (t) => {
    const output = t.context.service.compile('const x = 10', 'test.ts');
    expect(output).toMatch('var x = 10;');
  });
});
