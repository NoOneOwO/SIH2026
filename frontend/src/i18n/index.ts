/**
 * AquaShield 3D — i18n Configuration
 * Bilingual support: English + Hindi for key screens and alert templates.
 */

import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

const resources = {
  en: {
    translation: {
      // Navigation
      'nav.dashboard': 'Dashboard',
      'nav.incidentConsole': 'Incident Console',
      'nav.eapDashboard': 'EAP Dashboard',
      'nav.scenarioManager': 'Scenario Manager',
      'nav.alertConsole': 'Alert Console',
      'nav.evacuationPlanner': 'Evacuation Planner',
      'nav.reportGenerator': 'Report Generator',
      'nav.audit': 'Audit Trail',
      'nav.assistant': 'AI Assistant',
      'nav.admin': 'Admin',
      'nav.settings': 'Settings',

      // Common
      'common.loading': 'Loading...',
      'common.error': 'Error',
      'common.save': 'Save',
      'common.cancel': 'Cancel',
      'common.submit': 'Submit',
      'common.approve': 'Approve',
      'common.dispatch': 'Dispatch',
      'common.back': 'Back',
      'common.next': 'Next',
      'common.search': 'Search...',
      'common.noData': 'No data available',
      'common.status': 'Status',
      'common.actions': 'Actions',
      'common.createdAt': 'Created',
      'common.updatedAt': 'Updated',

      // Dam & Scenarios
      'dam.title': 'Dam Information',
      'scenario.title': 'Scenarios',
      'scenario.create': 'Create Scenario',
      'scenario.failureMode': 'Failure Mode',
      'scenario.variant': 'Variant',
      'scenario.status': 'Status',
      'scenario.overtopping': 'Overtopping',
      'scenario.piping': 'Piping',
      'scenario.controlledRelease': 'Controlled Release',
      'scenario.draft': 'Draft',
      'scenario.submitted': 'Submitted',
      'scenario.approved': 'Approved',
      'scenario.locked': 'Locked',

      // Simulation
      'sim.enqueue': 'Enqueue Simulation',
      'sim.running': 'Running...',
      'sim.completed': 'Completed',
      'sim.failed': 'Failed',
      'sim.massBalance': 'Mass Balance Error',
      'sim.withinTolerance': 'Within Tolerance',

      // Impact
      'impact.priority': 'Evacuation Priority',
      'impact.village': 'Village',
      'impact.population': 'Population',
      'impact.arrivalTime': 'Arrival Time',
      'impact.hazard': 'Hazard',
      'impact.priorityScore': 'Priority Score',
      'impact.roadStatus': 'Road Passability',
      'impact.safe': 'Safe',
      'impact.restricted': 'Restricted',
      'impact.impassable': 'Impassable',

      // Alerts
      'alert.title': 'Alert Console',
      'alert.draft': 'Draft Alert',
      'alert.approve': 'Approve Alert',
      'alert.dispatch': 'Dispatch Alert',
      'alert.severity': 'Severity',
      'alert.watch': 'Watch',
      'alert.warning': 'Warning',
      'alert.emergency': 'Emergency',
      'alert.approvalRequired': '⚠️ Human approval required before dispatch',

      // Reports
      'report.title': 'Report Generator',
      'report.generatePdf': 'Generate PDF Report',
      'report.downloadPdf': 'Download PDF',
      'report.viewHtml': 'View HTML Report',

      // Hazard
      'hazard.green': 'Low Risk',
      'hazard.yellow': 'Moderate Risk',
      'hazard.orange': 'High Risk',
      'hazard.red': 'Extreme Risk',

      // 3D View
      'view3d.title': '3D Digital Twin',
      'view3d.damOverview': 'Dam Overview',
      'view3d.firstHitVillage': 'First Hit Village',
      'view3d.criticalBridge': 'Critical Bridge',
      'view3d.districtCommand': 'District Command View',

      // Audit
      'audit.title': 'Audit Trail',
      'audit.entity': 'Entity',
      'audit.action': 'Action',
      'audit.actor': 'Actor',
      'audit.timestamp': 'Timestamp',

      // Footer / Disclaimers
      'disclaimer.title': 'Important Disclaimer',
      'disclaimer.text': 'This demonstration provides a planning and screening prototype. Operational use requires agency-authorized input data, calibrated model parameters, surveyed terrain/bathymetry, independent engineering review, and formal EAP approval.',
    },
  },
  hi: {
    translation: {
      // Navigation
      'nav.dashboard': 'डैशबोर्ड',
      'nav.incidentConsole': 'घटना कंसोल',
      'nav.eapDashboard': 'ईएपी डैशबोर्ड',
      'nav.scenarioManager': 'परिदृश्य प्रबंधक',
      'nav.alertConsole': 'अलर्ट कंसोल',
      'nav.evacuationPlanner': 'निकासी योजनाकार',
      'nav.reportGenerator': 'रिपोर्ट जेनरेटर',
      'nav.audit': 'ऑडिट ट्रेल',
      'nav.assistant': 'एआई सहायक',
      'nav.admin': 'प्रशासन',
      'nav.settings': 'सेटिंग्स',

      // Common
      'common.loading': 'लोड हो रहा है...',
      'common.error': 'त्रुटि',
      'common.save': 'सहेजें',
      'common.cancel': 'रद्द करें',
      'common.submit': 'प्रस्तुत करें',
      'common.approve': 'अनुमोदन',
      'common.dispatch': 'प्रेषण',
      'common.back': 'वापस',
      'common.next': 'अगला',
      'common.search': 'खोजें...',
      'common.noData': 'कोई डेटा उपलब्ध नहीं',
      'common.status': 'स्थिति',
      'common.actions': 'कार्यवाही',
      'common.createdAt': 'बनाया',
      'common.updatedAt': 'अपडेट',

      // Dam & Scenarios
      'dam.title': 'बांध जानकारी',
      'scenario.title': 'परिदृश्य',
      'scenario.create': 'परिदृश्य बनाएं',
      'scenario.failureMode': 'विफलता मोड',
      'scenario.variant': 'वेरिएंट',
      'scenario.status': 'स्थिति',
      'scenario.overtopping': 'अतिप्रवाह',
      'scenario.piping': 'पाइपिंग',
      'scenario.controlledRelease': 'नियंत्रित प्रकाशन',
      'scenario.draft': 'ड्राफ्ट',
      'scenario.submitted': 'प्रस्तुत',
      'scenario.approved': 'अनुमोदित',
      'scenario.locked': 'लॉक',

      // Simulation
      'sim.enqueue': 'सिमुलेशन सूचीबद्ध करें',
      'sim.running': 'चल रहा है...',
      'sim.completed': 'पूर्ण',
      'sim.failed': 'विफल',
      'sim.massBalance': 'द्रव्यमान संतुलन त्रुटि',
      'sim.withinTolerance': 'सहनशीलता के भीतर',

      // Impact
      'impact.priority': 'निकासी प्राथमिकता',
      'impact.village': 'गाँव',
      'impact.population': 'जनसंख्या',
      'impact.arrivalTime': 'आगमन समय',
      'impact.hazard': 'खतरा',
      'impact.priorityScore': 'प्राथमिकता स्कोर',
      'impact.roadStatus': 'सड़क स्थिति',
      'impact.safe': 'सुरक्षित',
      'impact.restricted': 'प्रतिबंधित',
      'impact.impassable': 'अतिक्रमणीय',

      // Alerts
      'alert.title': 'अलर्ट कंसोल',
      'alert.draft': 'अलर्ट ड्राफ्ट',
      'alert.approve': 'अलर्ट अनुमोदन',
      'alert.dispatch': 'अलर्ट प्रेषण',
      'alert.severity': 'गंभीरता',
      'alert.watch': 'निगरानी',
      'alert.warning': 'चेतावनी',
      'alert.emergency': 'आपातकाल',
      'alert.approvalRequired': '⚠️ प्रेषण से पहले मानव अनुमोदन आवश्यक',

      // Reports
      'report.title': 'रिपोर्ट जेनरेटर',
      'report.generatePdf': 'पीडीएफ रिपोर्ट बनाएं',
      'report.downloadPdf': 'पीडीएफ डाउनलोड',
      'report.viewHtml': 'HTML रिपोर्ट देखें',

      // Hazard
      'hazard.green': 'कम जोखिम',
      'hazard.yellow': 'मध्यम जोखिम',
      'hazard.orange': 'उच्च जोखिम',
      'hazard.red': 'अत्यधिक जोखिम',

      // Audit
      'audit.title': 'ऑडिट ट्रेल',
      'audit.entity': 'संस्था',
      'audit.action': 'कार्यवाही',
      'audit.actor': 'अभिनेता',
      'audit.timestamp': 'समय',

      // Disclaimer
      'disclaimer.title': 'महत्वपूर्ण अस्वीकरण',
      'disclaimer.text': 'यह प्रदर्शन एक योजना और स्क्रीनिंग प्रोटोटाइप प्रदान करता है। संचालनात्मक उपयोग के लिए एजेंसी-अधिकृत इनपुट डेटा, कैलिब्रेटेड मॉडल पैरामीटर्स, सर्वेक्षित भूमि/बाथमेट्री, स्वतंत्र इंजीनियरिंग समीक्षा, और औपचारिक ईएपी अनुमोदन आवश्यक है।',
    },
  },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
    debug: import.meta.env.DEV,
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
    },
  });

export default i18n;

