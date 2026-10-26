# heic-to 1.6.6 (unmodified CSP build)

Copyright Hopper Gee and upstream contributors. License: LGPL-3.0; see LICENSE.
Source and build instructions: https://github.com/hoppergee/heic-to/tree/v1.6.6
Exact distribution: https://registry.npmjs.org/heic-to/-/heic-to-1.6.6.tgz
SHA512: PYpOtPFEzgPxIoGF4LQ+oBD8o/tMvcFDNynrNzK1fLXfE6mTe2W+AHOvBKc5MwnVak4/Pnb51g9CJAtWL5YGWA==

The bundle contains libheif 1.23.6 and libde265 1.0.16 (LGPL), compiled with
Emscripten. Corresponding upstream sources and licenses:
- https://github.com/strukturag/libheif/tree/v1.23.6
- https://github.com/strukturag/libde265/tree/v1.0.16
- https://github.com/emscripten-core/emscripten

Loaded as a separate replaceable ES module, only for HEIC/HEIF imports.
Photos are decoded on the user's device, never sent to conversion services.
The browser worker is provided by the upstream bundle. The application converts
its decoded PNG output into a maximum-1600px WebP using the existing optimizer.
