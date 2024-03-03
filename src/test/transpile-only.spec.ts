import { createExec } from './helpers/exec';
import { ctxTsNode, tsSupportsVerbatimModuleSyntax } from './helpers';
import { CMD_TS_NODE_WITH_PROJECT_FLAG } from './helpers/command-lines';
import { TEST_DIR } from './helpers/paths';
import { expect, context } from './testlib';

const test = context(ctxTsNode);

test.suite('verbatimModuleSyntax  should not raise configuration diagnostic', (test) => {
  test.if(tsSupportsVerbatimModuleSyntax);
  test('test', async (t) => {
    // Mixing verbatimModuleSyntax
    // https://github.com/TypeStrong/ts-node/issues/1971
    // We should *not* get:
    // "error TS5104: Option 'isolatedModules' is redundant and cannot be specified with option 'verbatimModuleSyntax'."
    const service = t.context.tsNodeUnderTest.create({
      compilerOptions: { verbatimModuleSyntax: true },
    });
    service.compile('const foo: string = 123', 'module.ts');
  });
});
