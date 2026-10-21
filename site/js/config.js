/**
 * Konfiguracja frontendu.
 *
 * apiBase: adres lokalnego serwera z proxy rynkowym.
 *  - '' (domyślnie) - API na tym samym originie (zalecane: Docker na Dell Wyse),
 *  - 'http://192.168.1.50:8080' - gdy frontend jest hostowany gdzie indziej.
 */
window.INVESTOR_CONFIG = {
  apiBase: '',
};
