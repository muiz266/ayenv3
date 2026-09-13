/**
 * Theme Initialization Script
 * Runs synchronously on page load before CSS renders
 * Prevents FOUC (Flash of Unstyled Content)
 */
(function() {
    'use strict';
    try {
        // Clear dark mode class if it was previously set
        document.documentElement.classList.remove('theme-dark');
        
        // Remove old theme setting from localStorage
        localStorage.removeItem('ayen_theme');
        
        // Validate stored customer maps data
        // Remove if corrupted or doesn't contain valid URL
        var storedMaps = localStorage.getItem('ayen_customer_maps');
        if (storedMaps) {
            var isBadData = String(storedMaps).indexOf('[object') !== -1;
            var isValidUrl = /^https?:\/\//i.test(String(storedMaps).trim());
            
            if (isBadData || !isValidUrl) {
                localStorage.removeItem('ayen_customer_maps');
            }
        }
    } catch (error) {
        // Fail silently - localStorage may be disabled or full
        console.warn('Theme initialization skipped:', error.message);
    }
})();
