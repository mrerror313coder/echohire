/** @type {import('next').NextConfig} */
const hostedApi = "https://echohire-api-mzrq.onrender.com";

const nextConfig = {
  async rewrites() {
    return [
      {
        source: "/echo-api/:path*",
        destination: `${hostedApi}/:path*`,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/",
        headers: [{ key: "Cache-Control", value: "no-store" }],
      },
    ];
  },
};

export default nextConfig;
