// A DNS sinkhole: every Mac pointed at this as its DNS server gets NXDOMAIN
// for anything in blocked_domains, and a normal answer (forwarded to a real
// upstream resolver) for everything else. This blocks a domain for every
// app on the machine, not just one browser — unlike the earlier attempt to
// "block http" at our own catalog server, which only ever affected requests
// to our own app.
//
// This is a separate process from server.js (the catalog/admin app) — DNS
// is UDP on port 53, not HTTP, so it can't live inside the Fastify app. It
// shares the same catalog.db, reading blocked_domains directly.
//
// Binding port 53 needs root — that's an OS restriction on all privileged
// ports, not something this code can avoid. Run this with `sudo node
// src/dns-filter-server.js`, same as the Santa install needed an interactive
// sudo password earlier.
const dns2 = require('dns2');
const { Packet } = dns2;
const db = require('./db');

const PORT = Number(process.env.DNS_FILTER_PORT) || 53;
const HOST = process.env.DNS_FILTER_HOST || '0.0.0.0';
const UPSTREAM_DNS = process.env.UPSTREAM_DNS || '1.1.1.1';

const resolveUpstream = dns2.UDPClient({ dns: UPSTREAM_DNS });

function isBlocked(name) {
  const normalized = name.toLowerCase().replace(/\.$/, '');
  const blocked = db.prepare(`SELECT domain FROM blocked_domains`).all();
  return blocked.some(
    (b) => normalized === b.domain || normalized.endsWith(`.${b.domain}`)
  );
}

const server = dns2.createServer({
  udp: true,
  handle: async (request, send) => {
    const response = Packet.createResponseFromRequest(request);
    const [question] = request.questions;
    const { name, type } = question;

    if (isBlocked(name)) {
      response.header.rcode = Packet.RCODE.NXDOMAIN;
      return send(response);
    }

    try {
      const upstream = await resolveUpstream(name, Packet.TYPE_NAME[type] || 'A');
      response.answers = upstream.answers;
      send(response);
    } catch (err) {
      response.header.rcode = Packet.RCODE.SERVFAIL;
      send(response);
    }
  },
});

server.on('listening', () => {
  console.log(`DNS sinkhole listening on ${HOST}:${PORT}, forwarding allowed queries to ${UPSTREAM_DNS}`);
});

server.on('requestError', (error) => {
  console.error('bad DNS request from client:', error);
});

server.listen({ udp: { port: PORT, address: HOST } });
