import { readdirSync } from 'node:fs';
import { posix } from 'node:path';

/**
 * HOW MANY FILES A GUARD'S SCAN SHOULD HAVE FOUND.
 *
 * Every source-scanning guardrail opens with "the scan is not vacuous": a
 * broken glob finds nothing, and a guard that checks nothing passes. Until T28
 * (#225) that check was an absolute number (`> 300`, `> 100`) sized to a tree
 * that still carried inflect's 470-file component library. T28 deleted the
 * unreachable part of it, and the next deletion would have broken the floors
 * for no reason, or worse, been "fixed" by lowering them until they meant
 * nothing.
 *
 * So the floor is derived instead. `treeFiles` counts the same files a second,
 * independent way (a recursive readdir instead of fs.globSync), and the guard
 * asserts that its glob found every one of them. A glob that silently matches a
 * subset fails; deleting a component does not. The sentinels in each guard
 * catch the remaining case, both enumerations agreeing on the wrong directory.
 */
export function treeFiles(dirs: readonly string[], ext: RegExp): string[] {
  return dirs
    .flatMap((dir) =>
      readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile() && ext.test(e.name))
        .map((e) => posix.join(e.parentPath.split('\\').join('/'), e.name)),
    )
    .sort();
}
