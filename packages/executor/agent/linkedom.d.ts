// The part of linkedom the executor uses. linkedom's own declarations do not match the DOM
// library's, so type checking reads this one; at runtime the pinned package is loaded.
export function parseHTML(html: string): { document: Document };
