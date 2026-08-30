const basePath = import.meta.env.BASE_URL;

export function apiUrl(path: string): string {
  return `${basePath}api${path.startsWith("/") ? path : `/${path}`}`;
}

export function appUrl(search = ""): string {
  return `${basePath}${search}`;
}
