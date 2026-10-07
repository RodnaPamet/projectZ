/** @jest-environment node */
import {
  PACKAGE_SRC,
  aliasTarget,
  inflectLocations,
  playerzPath,
} from '../../../scripts/ui-sync/inflect-package.mjs';

/**
 * Where upstream keeps a file once inflect #3046 has moved it into its
 * @inflect/ui package, and where playerz keeps the copy. Every ui-sync tool
 * and the guardrails' import resolvers go through these three functions, so a
 * wrong answer here is a moved file reported GONE, or an import edge a guard
 * silently stops following.
 */

describe('playerzPath', () => {
  it('maps the package onto src/, and leaves every other path alone', () => {
    expect(PACKAGE_SRC).toBe('packages/ui/src/');
    expect(playerzPath('packages/ui/src/lib/cn.ts')).toBe('src/lib/cn.ts');
    expect(playerzPath('packages/ui/src/components/ui/icons/nucleo/check2.tsx')).toBe(
      'src/components/ui/icons/nucleo/check2.tsx',
    );
    expect(playerzPath('src/components/ui/button.tsx')).toBe('src/components/ui/button.tsx');
    // The package's own files outside src/ are not copies of anything here.
    expect(playerzPath('packages/ui/package.json')).toBe('packages/ui/package.json');
  });
});

describe('inflectLocations', () => {
  it('names both layouts of one file, the package first, from either one', () => {
    const both = [
      'packages/ui/src/components/ui/hooks/use-toast.ts',
      'src/components/ui/hooks/use-toast.ts',
    ];
    expect(inflectLocations('src/components/ui/hooks/use-toast.ts')).toEqual(both);
    expect(inflectLocations('packages/ui/src/components/ui/hooks/use-toast.ts')).toEqual(both);
    expect(inflectLocations('src/components/ui')).toEqual([
      'packages/ui/src/components/ui',
      'src/components/ui',
    ]);
  });

  it('gives a path outside src/ only itself', () => {
    expect(inflectLocations('docs/x.md')).toEqual(['docs/x.md']);
    expect(inflectLocations('packages/ui/README.md')).toEqual(['packages/ui/README.md']);
  });
});

describe('aliasTarget', () => {
  it('reads @/ and @inflect/ui/ as src/, as tsconfig.json and jest.config.mjs do', () => {
    expect(aliasTarget('@/lib/cn')).toBe('src/lib/cn');
    expect(aliasTarget('@inflect/ui/lib/cn')).toBe('src/lib/cn');
    expect(aliasTarget('@inflect/ui/components/ui/icons/nucleo')).toBe(
      'src/components/ui/icons/nucleo',
    );
  });

  it('leaves relative specifiers, packages and the bare package index alone', () => {
    expect(aliasTarget('./cn')).toBeNull();
    expect(aliasTarget('../../../lib/cn')).toBeNull();
    expect(aliasTarget('react')).toBeNull();
    expect(aliasTarget('@radix-ui/react-dialog')).toBeNull();
    // packages/ui/src/index.ts is not vendored: a file that imports it needs it copied first.
    expect(aliasTarget('@inflect/ui')).toBeNull();
    expect(aliasTarget('@inflect/uikit/x')).toBeNull();
  });
});
