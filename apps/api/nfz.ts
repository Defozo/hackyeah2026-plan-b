import type { ApiConfig } from "./config.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
const text = (value: unknown) =>
  typeof value === "string" && value.trim() ? value : null;
export function triState(value: unknown): boolean | null {
  return value === "Y" || value === true
    ? true
    : value === "N" || value === false
      ? false
      : null;
}
export interface CareQueue {
  id: string;
  name: string;
  place: string | null;
  address: string | null;
  locality: string | null;
  phone: string | null;
  benefit: string | null;
  category: number | null;
  pcus: string | null;
  applicable: boolean | null;
  situationAsAt: string | null;
  sourceUrl: string;
  accessibility: Record<string, boolean | null>;
}
export interface CareResult<T> {
  items: T[];
  page: number;
  hasNext: boolean;
  total: number | null;
  source: string;
  fetchedAt: string;
  cache: "live" | "fresh" | "stale";
  warning?: string;
}
export function mapQueue(value: unknown): CareQueue {
  const row = object(value);
  const attributes = object(row.attributes);
  const dates = object(attributes.dates);
  const accessibility = Object.fromEntries(
    [
      "toilet",
      "ramp",
      "car-park",
      "elevator",
      "automatic-door",
      "wheelchairs",
      "corridors",
    ].map((key) => [key, triState(attributes[key])]),
  );
  return {
    id: text(row.id) || "",
    name:
      text(attributes.provider) ||
      text(attributes.place) ||
      "Brak nazwy placówki",
    place: text(attributes.place),
    address: text(attributes.address),
    locality: text(attributes.locality),
    phone: text(attributes.phone),
    benefit: text(attributes.benefit),
    category: typeof attributes.case === "number" ? attributes.case : null,
    pcus: text(dates.pcus),
    applicable: triState(dates.applicable),
    situationAsAt: text(dates["date-situation-as-at"]),
    accessibility,
    sourceUrl: "https://terminyleczenia.nfz.gov.pl/",
  };
}
export class NfzService {
  private readonly cache = new Map<string, CareResult<unknown>>();
  constructor(
    private readonly config: ApiConfig,
    private readonly fetcher: typeof fetch = fetch,
  ) {}
  async search(
    type: "benefits" | "localities" | "queues",
    params: Record<string, string>,
  ): Promise<CareResult<unknown>> {
    const query = new URLSearchParams({
      "api-version": "1.4",
      format: "json",
      limit: "10",
      ...params,
    });
    const url = `${this.config.nfzBaseUrl}${type}?${query}`;
    const cached = this.cache.get(url);
    if (
      cached &&
      Date.now() - Date.parse(cached.fetchedAt) <
        this.config.nfzCacheTtlSeconds * 1000
    )
      return { ...cached, cache: "fresh" };
    try {
      const response = await this.fetcher(url, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error("NFZ_UNAVAILABLE");
      const raw = object(await response.json());
      if (!Array.isArray(raw.data) || raw.data.length > 25)
        throw new Error("NFZ_INVALID_RESPONSE");
      const meta = object(raw.meta);
      const links = object(raw.links);
      const result: CareResult<unknown> = {
        items:
          type === "queues"
            ? raw.data.map(mapQueue)
            : raw.data
                .filter((item): item is string => typeof item === "string")
                .map((name) => ({ id: name, name })),
        page: Number(params.page || 1),
        total: typeof meta.count === "number" ? meta.count : null,
        hasNext: Boolean(text(links.next)),
        source: "NFZ Terminy Leczenia v1.4",
        fetchedAt: new Date().toISOString(),
        cache: "live",
      };
      if (this.cache.size >= 100)
        this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(url, result);
      return result;
    } catch {
      if (cached)
        return {
          ...cached,
          cache: "stale",
          warning:
            "Nie udało się odświeżyć placówek. Pokazujemy wcześniejszy odczyt, sprawdź datę pobrania.",
        };
      throw new Error("NFZ_UNAVAILABLE");
    }
  }
}
