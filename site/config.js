// Bedsplit site settings. Edit this file, then redeploy.
// Anything left empty stays switched off, so the site works as-is.
window.BEDSPLIT_CONFIG = {
  // Donate button in the header (Ko-fi, Buy Me a Coffee, GitHub Sponsors…). '' hides it.
  donateUrl: '',

  // Amazon Associates tracking ID, e.g. 'bedsplit-20'. When set, the Amazon links
  // below get ?tag=… added and the bigger-printer and supplies links appear.
  amazonTag: '',

  // Google AdSense. client looks like 'ca-pub-1234567890123456'; slot is the ad unit ID.
  // Leave client '' until AdSense approves the site. Also update /ads.txt.
  adsense: { client: '', sidebarSlot: '', guideSlot: '' },

  // Printers suggested when a bigger bed would need fewer parts.
  // bed = [X, Y, Z] in mm. url can be any affiliate link; Amazon links get the tag added.
  printers: [
    { name: 'Bambu Lab P1S', bed: [256, 256, 256], url: 'https://www.amazon.com/s?k=Bambu+Lab+P1S' },
    { name: 'Creality K1 Max', bed: [300, 300, 300], url: 'https://www.amazon.com/s?k=Creality+K1+Max' },
    { name: 'Bambu Lab H2D', bed: [325, 320, 325], url: 'https://www.amazon.com/s?k=Bambu+Lab+H2D' },
    { name: 'Elegoo OrangeStorm Giga', bed: [800, 800, 1000], url: 'https://www.amazon.com/s?k=Elegoo+OrangeStorm+Giga' }
  ],

  // Shown under the parts list after a split. joints: which joint types it applies to ('mold' = mold mode).
  supplies: [
    { label: 'Medium CA glue + activator', url: 'https://www.amazon.com/s?k=medium+CA+glue+activator', joints: ['peg', 'dowel', 'flat'] },
    { label: 'Wooden dowel pins (for dowel holes)', url: 'https://www.amazon.com/s?k=wooden+dowel+pins+8mm', joints: ['dowel'] },
    { label: 'PLA filament', url: 'https://www.amazon.com/s?k=PLA+filament+1kg', joints: ['peg', 'dowel', 'flat'] },
    { label: 'Mold release spray', url: 'https://www.amazon.com/s?k=ease+release+200', joints: ['mold'] },
    { label: 'Casting epoxy resin', url: 'https://www.amazon.com/s?k=casting+epoxy+resin', joints: ['mold'] },
    { label: 'Mold-making silicone', url: 'https://www.amazon.com/s?k=mold+making+silicone+rubber', joints: ['mold'] },
    { label: 'XTC-3D print coating', url: 'https://www.amazon.com/s?k=XTC-3D', joints: ['mold'] }
  ]
};
