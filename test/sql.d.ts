// Vite's ?raw suffix lets the test harness load the real schema instead of a
// hand-maintained copy that could drift from production.
declare module '*.sql?raw' {
  const content: string;
  export default content;
}
