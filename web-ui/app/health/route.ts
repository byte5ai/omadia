// Fly.io health-check endpoint. Not a page — returns plain JSON so the
// check never accidentally returns HTML that looks 2xx but isn't alive.
export function GET(): Response {
  return Response.json({ status: 'ok', service: 'odoo-bot-harness' });
}
