export default {
  async fetch(): Promise<Response> {
    return new Response('edge scaffold (Phase 1 uses public demo server)', { status: 200 });
  }
};

