// Shared tool error class. Separate module so crustdata.js can import it
// without a circular dependency on the target.
export class ToolError extends Error {
  constructor(msg) { super(msg); this.name = 'ToolError'; this.isToolError = true; }
}
