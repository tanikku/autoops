export { auth as middleware } from "@/auth";

// Only the dashboard is protected. The landing page stays public.
export const config = {
  matcher: ["/dashboard/:path*"],
};
