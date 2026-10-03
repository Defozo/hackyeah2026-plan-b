import type { Plugin } from "vite";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join, relative } from "node:path";
import { createHash } from "node:crypto";
/** Explicit app-only precache. API responses and user documents are never cached. */
export function localPwa(): Plugin {
  return {
    name: "planb-local-pwa",
    apply: "build",
    async closeBundle() {
      const out = resolve("apps/web/dist");
      const paths: string[] = [];
      async function walk(dir: string) {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          if (
            relative(out, full).replaceAll("\\", "/").split("/")[0] ===
            "materialy"
          )
            continue;
          if (entry.isDirectory()) await walk(full);
          else if (
            !["sw.js", "pwa-build.json"].includes(entry.name) &&
            !entry.name.endsWith(".map")
          )
            paths.push(full);
        }
      }
      await walk(out);
      paths.sort();
      const hash = createHash("sha256");
      let size = 0;
      for (const p of paths) {
        const b = await readFile(p);
        hash.update(relative(out, p));
        hash.update(b);
        size += b.length;
      }
      const version = hash.digest("hex").slice(0, 16);
      const urls = paths.map(
        (p) => "/" + relative(out, p).replaceAll("\\", "/"),
      );
      const sw = `const CACHE='planb-shell-${version}';const URLS=${JSON.stringify(urls)};const KNOWN=new Set(URLS);self.addEventListener('install',event=>event.waitUntil((async()=>{try{const cache=await caches.open(CACHE);for(let i=0;i<URLS.length;i+=12)await cache.addAll(URLS.slice(i,i+12).map(url=>new Request(url,{cache:'reload'})));}catch(error){await caches.delete(CACHE);throw error;}})()));self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const key of await caches.keys())if(key.startsWith('planb-shell-')&&key!==CACHE)await caches.delete(key);await self.clients.claim();})()));self.addEventListener('message',event=>{if(event.data==='ACTIVATE_UPDATE')self.skipWaiting();if(event.data==='OFFLINE_STATUS')event.ports[0]?.postMessage({ready:true,version:'${version}',files:URLS.length,bytes:${size}});});self.addEventListener('fetch',event=>{const request=event.request;const url=new URL(request.url);if(request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/')||url.pathname.startsWith('/health/')||url.pathname==='/materialy'||url.pathname.startsWith('/materialy/'))return;if(request.mode==='navigate'){event.respondWith(caches.open(CACHE).then(async cache=>{const stored=await cache.match('/index.html');return stored?new Response(stored.body,{status:stored.status,statusText:stored.statusText,headers:stored.headers}):fetch(request);}));return;}if(KNOWN.has(url.pathname))event.respondWith(caches.open(CACHE).then(async cache=>await cache.match(url.pathname)||fetch(request)));});`;
      await writeFile(join(out, "sw.js"), sw);
      await writeFile(
        join(out, "pwa-build.json"),
        JSON.stringify({ version, files: urls.length, bytes: size }, null, 2),
      );
      console.log(
        `Plan B offline: ${urls.length} app assets, ${(size / 1048576).toFixed(1)} MB, version ${version}`,
      );
    },
  };
}
