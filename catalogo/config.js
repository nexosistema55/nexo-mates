window.BASE_COMERCIOS_BUSINESS_CONFIG = {
  businessName: "Nexo mates",
  whatsappNumber: "+5493564526723",
  defaultWhatsappMessage: "Hola {businessName}, quiero consultar por este producto:",
  sizeAvailabilityMode: "show-unavailable",
  outOfStockProductMode: "show",
};

window.BASE_COMERCIOS_CATALOG_REMOTE_CONFIG = {
  enabled: window.NEXO_REMOTE_CONFIG?.enabled === true,
  supabaseUrl: window.NEXO_REMOTE_CONFIG?.supabaseUrl || "",
  supabasePublishableKey: window.NEXO_REMOTE_CONFIG?.supabasePublishableKey || "",
  productsView: "catalog_products",
};
