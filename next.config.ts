import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
<<<<<<< HEAD
  poweredByHeader: false
=======
  poweredByHeader: false,
  serverExternalPackages: ["pdfkit"],
  outputFileTracingIncludes: {
    "/api/daily-analysis/reports/[reportId]/pdf": [
      "./node_modules/pdfkit/package.json",
      "./node_modules/pdfkit/js/standard-fonts/**"
    ]
  }
>>>>>>> saikat
};

export default config;
