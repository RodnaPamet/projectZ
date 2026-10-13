/**
 * A RENDERED TEST THAT LOADS THE DATABASE CLIENT FAILS, EVERYWHERE, WITH THE
 * REASON (#532).
 *
 * tests/helpers/rtl-setup.ts explains why. This is the proof the rule is
 * armed: without it, a rendered suite whose component reaches the database
 * through a server action would pass on a newer Node and fail to load on CI's.
 */
describe('the database client under jsdom', () => {
  it('cannot be loaded, and the error says what to do', () => {
    expect(() => jest.requireMock('@/lib/db/prisma')).toThrow(
      /rendered \(jsdom\) test loaded the database client/,
    );
  });

  it('nor through a module that imports it', () => {
    jest.isolateModules(() => {
      expect(() => require('@/app-layer/usecases/my-locale')).toThrow(
        /rendered \(jsdom\) test loaded the database client/,
      );
    });
  });
});
