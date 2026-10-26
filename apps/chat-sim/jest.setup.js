// react-test-renderer has no automatic cleanup. A ChatScreen left mounted keeps
// its status/poll timers alive, and one firing after Jest tears the environment
// down logs an error that fails the whole run even when every test passed.
// Track each renderer a test creates and unmount it once the test is done.
const TestRenderer = require('react-test-renderer');

const mounted = new Set();
const originalCreate = TestRenderer.create;

TestRenderer.create = (...args) => {
  const renderer = originalCreate(...args);
  mounted.add(renderer);
  return renderer;
};

afterEach(() => {
  for (const renderer of mounted) {
    try {
      TestRenderer.act(() => renderer.unmount());
    } catch {
      // already unmounted by the test itself
    }
  }
  mounted.clear();
});
