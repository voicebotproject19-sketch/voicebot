class companyKnowledgeBaseGerman {
    constructor() {
        // ── Per-client contact config ─────────────────────────────────────────
        // Same company as the English KB — same transfer number and email.
        // Override via environment variables for deployment flexibility.
        this.contact = {
            transferNumber:    process.env.company_TRANSFER_NUMBER    || null,
            notificationEmail: process.env.company_NOTIFICATION_EMAIL || 'leads@company.com',
            ccEmail:           process.env.FALLBACK_CC_EMAIL               || null,
        };
        // ─────────────────────────────────────────────────────────────────────

        this.knowledgeBase = [
            {
                id: "company_info",
                category: "Allgemeine Unternehmensinformationen",
                keywords: ["company", "unternehmen", "über uns", "gegründet", "team", "erfahrung", "kunden", "marken", "hauptsitz", "noida", "usa", "abgeschlossene projekte", "zufriedenheit", "bewertung", "clutch", "goodfirms", "zertifizierungen", "iso", "microsoft", "eo", "ypo"],
                priority: 1,
                content: "company entwickelt maßgeschneiderte Software, Webplattformen, mobile Anwendungen, E-Commerce-Lösungen, KI-Systeme und cloudbasierte Anwendungen für Unternehmen jeder Größe, von Start-ups bis zu Großunternehmen. Gegründet im Jahr 2000, seit über 25 Jahren tätig mit Kunden in über 50 Ländern. Über 10.000 erfolgreich abgeschlossene Projekte. 100% Kundenzufriedenheit mit 4,9 von 5 Bewertung auf Clutch und GoodFirms. Hauptsitz in Noida, Indien mit zusätzlicher Präsenz in den USA. Team von über 300 Vollzeit-Fachleuten, darunter Entwickler, Designer, QA-Analysten, Projektmanager und Support-Ingenieure. Erfahrung in den Bereichen Einzelhandel, Gesundheitswesen, Finanzen, Bildung, Fertigung und vielen anderen Branchen. Arbeitet mit bekannten Marken wie Steve Madden, Dabur, Stem City USA, PayPal, Bata, YMCA, Happy Planner, Smartr365, All Here, Mother Dairy, Entrepreneurs' Organization, AwarenessIdeas4U, Ramp Group sowie Regierungs- und gemeinnützigen Organisationen zusammen. Zertifiziert von Microsoft, EO, YPO und ISO. Garantierte Antwort in weniger als 24 Stunden."
            },
            {
                id: "portfolio_showcase",
                category: "Portfolio & Fallstudien",
                keywords: ["portfolio", "arbeiten", "beispiele", "fallstudien", "steve madden", "happy planner", "smartr365", "entrepreneurs organization", "chatbot", "rpa", "fda thailand", "awarenessideas4u", "mother dairy", "all here", "ramp group"],
                priority: 1,
                content: "Aktuelle Portfolio-Highlights: Shopify-Onlineshop für Steve Madden (USA), mobile App für Smartr365 (UK), Magento-Website für Happy Planner, RPA-Automatisierung für Ramp Group, Moodle-Plattform für FDA Thailand, Flutter-Chatbot für Entrepreneurs' Organization, E-Commerce-Shop für AwarenessIdeas4U. Projekte umfassen Branchen wie Gesundheitswesen, Bildung, Finanzen, Einzelhandel und Immobilien. Hunderte von Shopify-Shops gebaut, darunter hochkarätige Marken. Vollständiges Portfolio auf der Website verfügbar oder kann auf Anfrage per E-Mail zugesandt werden. Erfolgsorientierte Lösungen, die Kunden helfen, Umsatzziele mit vollständiger Transparenz zu erreichen."
            },
            {
                id: "value_proposition",
                category: "Unternehmens-Alleinstellungsmerkmale",
                keywords: ["anders", "einzigartig", "warum wählen", "vorteil", "vorteile", "transparenz", "erfolg", "umsatz", "zuhören", "verstehen", "schnell", "rasch", "dringend", "termin", "durchlaufzeit"],
                priority: 1,
                content: "Hauptunterscheidungsmerkmale: Zuhören, lernen und das Geschäft zuerst verstehen, bevor Lösungen entwickelt werden. Fokus auf erfolgsorientierte Ergebnisse, die helfen, Umsatzziele zu erreichen. Vollständige Transparenz während des gesamten Projektlebenszyklus. 100% Kundenzufriedenheits-Erfolgsbilanz. Spezialisierung auf schnelle Durchlaufzeiten mit Teams, die für dringende Projekte bereit sind. Dedizierter Projektmanager für jeden Kunden mit direktem Teamzugang. Kostenlose und unverbindliche Angebote innerhalb von Stunden bereitgestellt. Nachgewiesene Erfolgsbilanz mit großen Marken und komplexen Projekten in mehreren Branchen."
            },
            {
                id: "software_development",
                category: "Maßgeschneiderte Softwareentwicklung",
                keywords: ["software", "maßgeschneiderte software", "geschäftsanwendung", "finanzsystem", "buchhaltung", "desktop", "chat-plattform", "dashboard", "überwachung", "workflow-automatisierung", "berichterstattung", "asp.net", "microsoft stack", "desktop-anwendung", "unternehmenslösung"],
                priority: 2,
                content: "Maßgeschneiderte Geschäftsanwendungen, Finanzsysteme, Buchhaltungssoftware, Desktop-Dienstprogramme, Chat-Plattformen, Barrierefreiheitslösungen, Reporting-Dashboards, Überwachungstools und Workflow-Automatisierungssysteme. End-to-End-Entwicklung für branchenspezifische Anforderungen mit skalierbarer Architektur. Experte im vollständigen Microsoft-Stack einschließlich ASP.NET-Websites, Desktop-Anwendungen und Unternehmenslösungen. Technologien umfassen moderne Frameworks und Programmiersprachen, die auf Geschäftsanforderungen zugeschnitten sind. Integrationsmöglichkeiten mit bestehenden Unternehmenssystemen. Fokus auf Benutzerfreundlichkeit, Leistung und Wartbarkeit."
            },
            {
                id: "mobile_development",
                category: "Mobile App-Entwicklung",
                keywords: ["mobil", "app", "android", "ios", "react native", "flutter", "xamarin", "swift", "kotlin", "java", "unity", "smartphone", "tablet", "phonegap", "chatbot", "essenslieferung", "gesundheits-app", "soziale netzwerke", "buchung", "streaming", "finanz-app", "on-demand", "nativ", "plattformübergreifend"],
                priority: 2,
                content: "Native und plattformübergreifende Apps für iOS und Android mit React Native, Flutter, Xamarin, PhoneGap. Technologien: Swift, Kotlin, Java, React Native, Flutter, Unity, Cloud-Plattformen. Projekterfahrung umfasst Chatbots (wie Flutter-Chatbot für Entrepreneurs' Organization), Essenslieferungs-Apps, medizinische und Gesundheits-Apps (Smartr365, All Here), Social-Networking-Apps, Buchungsplattformen, Media-Streaming-Apps, Finanz-Apps und On-Demand-Service-Apps. Vollständiges UI/UX-Design mit benutzerfreundlichen Oberflächen und ansprechenden Interaktionen. Branchenspezifische Apps für Gesundheitswesen, Bildung, Finanzen, Einzelhandel, Reisen, Automobil. Vollständige Code- und Design-Eigentumsübertragung nach Abschluss. Drittanbieter-API- und Zahlungsgateway-Integration. App-Store-Veröffentlichungshilfe für Google Play und Apple App Store. Regelmäßige Fortschrittsaktualisierungen durch Meetings, E-Mails, Projektmanagement-Tools. Bestehende App-Redesign- und Upgrade-Services mit neuen Funktionen und Leistungsverbesserungen."
            },
            {
                id: "website_development",
                category: "Website-Entwicklung",
                keywords: ["website", "web", "seite", "portal", "responsiv", "html", "css", "javascript", "php", "laravel", "node", "react", "angular", "python", "drupal", "wix", "dotnet", ".net", "unternehmens", "bildung", "elearning", "medien", "unterhaltung", "fertigung", "industriell", "gemeinnützig", "ngo", "blog", "maßgeschneiderte website", "web-app", "redesign"],
                priority: 2,
                content: "Geschäftswebsites, E-Commerce-Shops, Unternehmensseiten, Portale, Bildungsplattformen. Technologien: PHP, Laravel, Node.js, React, Angular, Python, WordPress, Drupal, Shopify, Wix, .NET, ASP.NET. Tausende von maßgeschneiderten Websites und Webanwendungen erstellt. Projekterfahrung umfasst Unternehmenswebsites, Bildungsportale, eLearning-Plattformen, Medien- und Unterhaltungsseiten, Fertigungs- und Industriewebsites, gemeinnützige und NGO-Portale, Blogging-Plattformen und E-Commerce-fähige Geschäftswebsites. Maßgeschneiderte Designs basierend auf Marke und Zielen (Vorlagen nur auf Anfrage). Domain-Registrierung und Webhosting-Unterstützung. Content-Management-Systeme für einfache Selbstbearbeitung. Professionelle Content-Writing-Services. Drittanbieter-Integrationen: Zahlungsgateways, CRM, Analysen. SEO-freundliche Struktur und Optimierung. Plattformmigration mit Daten- und Funktionalitätserhaltung. Cross-Browser-Kompatibilitätstests. Social-Media-Integration für Content-Sharing und Engagement. Analyse-Integration für Besucher- und Leistungsverfolgung. Mehrsprachige und mehrwährungsfähige Website-Unterstützung. Webanwendungen mit benutzerdefinierten Funktionen, Benutzeranmeldungen, Dashboards, interaktiven Funktionen. Branding-Unterstützung einschließlich Logo-Design und visueller Identität. Vollständige Redesign-, Migrations- und Leistungsoptimierungsservices verfügbar. Durchschnittliche Zeitrahmen: Basis-Website 3-4 Wochen, komplexe Plattformen mehrere Monate."
            },
            {
                id: "ecommerce_solutions",
                category: "E-Commerce-Lösungen",
                keywords: ["ecommerce", "e-commerce", "onlineshop", "shopping", "shopify", "magento", "woocommerce", "bigcommerce", "opencart", "zahlungsgateway", "paypal", "stripe", "nopcommerce", "marktplatz", "mode", "lifestyle", "gesundheit", "schönheit", "b2b", "großhandel", "schmuck", "abo-shop", "steve madden", "happy planner", "awarenessideas4u", "millionen umsatz"],
                priority: 2,
                content: "Maßgeschneiderte E-Commerce-Entwicklung, Plattform-Setup, mobile Apps, Zahlungsintegration, Multichannel-Unterstützung, SEO, Wartung. Technologien: Shopify, Magento, WooCommerce, BigCommerce, OpenCart, nopCommerce, Drupal, Odoo. Spezialist für Shopify, Magento, BigCommerce und maßgeschneiderte Shops. Hunderte von Shopify-Shops gebaut, darunter hochkarätige wie Steve Madden und Happy Planner in den USA. Shops gestartet, die Millionen an Umsatz generieren. Projekterfahrung umfasst Onlineshops, mehrsprachige Marktplätze, Mode- und Lifestyle-Portale, Gesundheits- und Schönheitsplattformen, B2B-Großhandelslösungen, Schmuckgeschäfte, abonnementbasierte Shops und E-Commerce-Upgrades. Maßgeschneiderte Shops von Grund auf oder Plattform-Anpassung basierend auf Anforderungen und Budget. Sichere Zahlungsgateway-Integration: PayPal, Stripe, Authorize.net mit verschlüsselten Transaktionen. Mobile App-Entwicklung für iOS und Android mit Push-Benachrichtigungen, Empfehlungen, reibungslosem Checkout. SEO- und Digital-Marketing-Services einschließlich Optimierung, Content-Erstellung, Social-Media-Kampagnen. Responsives Design für Mobiltelefone, Tablets, Desktops mit geräteübergreifender Kompatibilität. Abonnementbasierter E-Commerce mit wiederkehrenden Zahlungen, Mitgliedschaftsverwaltung, automatisierter Abrechnung. CRM- und ERP-Systemintegration für Inventar-, Auftrags-, Kundeninformations-Synchronisation."
            },
            {
                id: "cloud_solutions",
                category: "Cloud-Lösungen",
                keywords: ["cloud", "aws", "azure", "google cloud", "migration", "hosting", "serverless", "docker", "kubernetes", "virtualisierung", "infrastruktur", "netsuite", "erp-integration", "crm-integration", "hypothek", "finanzlösung", "medienplattform", "content-plattform", "elearning-portal", "unternehmens-web-app", "datenverwaltung"],
                priority: 2,
                content: "Remote-Server-Software, Datenspeicherung, Betriebsverwaltung für reduzierte Kosten und verbesserte Zugänglichkeit. Technologien: AWS, Azure, Google Cloud, NetSuite, Docker, Kubernetes, serverless Computing, Virtualisierung, Sicherheitstools. Projekterfahrung umfasst SaaS-Anwendungen, ERP- und CRM-Integrationen, Hypotheken- und Finanzlösungen, Medien- und Content-Plattformen, eLearning-Portale, Unternehmens-Web-Apps und sichere Datenverwaltungssysteme. Öffentliche, private, hybride, Multi-Cloud-Lösungen mit Kosten-, Sicherheits-, Leistungsbalance. Branchenspezialisierung: Gesundheitswesen, Finanzen, Bildung, Medien, Einzelhandel, Reisen, Immobilien, Automobil, Fertigung. Angepasste Cloud-Services für spezifische Workflows, Anwendungen, Teamgrößen. Flexible Preisgestaltung: Pay-as-you-go, reservierte Pläne, modulare Services. App-, Datenbank-, Workload-Migration mit Systemneukonfiguration und gründlichen Tests. Leistungsoptimierung mit besserer Rechenleistung, Speicher, Netzwerkressourcen. Spitzenlastbehandlung mit automatischer Skalierung, Lastausgleich, Server-Optimierung."
            },
            {
                id: "saas_development",
                category: "SaaS-Entwicklung",
                keywords: ["saas", "software as a service", "abonnement", "mandantenfähig", "cloud-software", "digitale zahlung", "dokumentenverwaltung", "hr", "lohnabrechnung", "beratung", "consulting", "workflow-management", "marketing-automatisierung", "datengesteuert"],
                priority: 2,
                content: "Cloud-gehostete Software, die über das Internet zugänglich ist, ohne lokale Installation. Zeitrahmen variiert: kleine Apps (wenige Wochen), größere Plattformen (mehrere Monate). Technologien: AWS, Azure, Google Cloud, Python, JavaScript, React, Node.js, Docker, Kubernetes. Projekterfahrung umfasst SaaS-Plattformen für digitale Zahlungen, Dokumentenverwaltung, HR und Lohnabrechnung, Beratungsdienste, Beratungsunternehmen, Workflow-Management, Marketing-Automatisierung und datengesteuerte Anwendungen. Vollständige SaaS-Entwicklung vom Konzept bis zur Bereitstellung mit Skalierbarkeit, Abonnementverwaltung und mandantenfähiger Architektur. Web- und mobile Versionen mit konsistenten Funktionen über Plattformen hinweg. Drittanbieter-API-Integrationen: Zahlungsgateways, CRMs, Analysen, soziale Plattformen. Preismodelle: Abonnementpläne, Freemium, gestaffelt, Pay-as-you-go. Cloud-Hosting auf AWS, Azure oder Google Cloud mit zuverlässiger Serververwaltung. Migration bestehender Software zum SaaS-Modell mit aktualisierter Architektur. Umfassende Tests: funktional, Leistung, Sicherheit, Benutzerfreundlichkeit vor Start."
            },
            {
                id: "crm_solutions",
                category: "Customer-Relationship-Management",
                keywords: ["crm", "kundenbeziehung", "vertrieb", "lead", "pipeline", "kundenverwaltung", "automatisierung", "verfolgung", "zoho", "dynamics", "gesundheitswesen-crm", "autohaus", "immobilien-crm", "migration"],
                priority: 2,
                content: "Organisiert Kundeninformationen, verfolgt Interaktionen, verwaltet Beziehungen. Projekterfahrung umfasst maßgeschneiderte CRM-Entwicklung, Migration, Integration mit Drittanbieter-Tools, Vertriebs-Pipeline-Automatisierung, Gesundheitswesen-CRM-Systeme, Autohaus-Management, Immobilien-CRMs und Zahlungsgateway-Integrationen mit Plattformen wie Zoho und Dynamics. Zentralisiert Kundendaten, verfolgt Interaktionen, automatisiert Aufgaben für verbesserten Vertrieb. Protokolliert Anrufe, E-Mails, Chats in einer einzigen Plattform für vollständige Kundenhistorie. Geeignet für Unternehmen aller Größen mit skalierbaren Funktionen. Integration mit E-Mail, Abrechnung, anderen Tools plus automatisierte Erinnerungen und Follow-ups. Sichere Datenspeicherung mit Verschlüsselung, Backups, Dashboards und Vertriebsberichten. Lead-Tracking, automatisierte Follow-ups, Pipeline-Management über Branchen hinweg. Support-Ticket-Tracking, Anfrageverwaltung, After-Sales-Kundenservice. Multi-User-Zugriff mit Echtzeit-Updates und automatisiertem Aufgabenmanagement. Cloud- vs. On-Premise-Optionen. KI- und Automatisierungsfunktionen für Aufgabenautomatisierung, Lead-Scoring, Vertriebsprognosen. Marketing-Kampagnenverwaltung mit Lead-Conversion-Analyse."
            },
            {
                id: "cms_solutions",
                category: "Content-Management-Systeme",
                keywords: ["cms", "content-management", "wordpress", "drupal", "joomla", "maßgeschneidertes cms", "content-bearbeitung", "veröffentlichung", "php-cms", "mitgliederportal", "intranet", "content-publishing", "sicherheitsfokussiert"],
                priority: 2,
                content: "Plattformen: WordPress, Drupal, Joomla, Shopify, Magento, maßgeschneidertes CMS. Projekterfahrung umfasst CMS-gesteuerte Websites für Branchen wie Finanzen, Gesundheitswesen, Bildung, Einzelhandel und Medien, einschließlich Content-Publishing-Plattformen, Mitgliederportale, Intranet-Systeme und sicherheitsfokussierte Websites mit Joomla, Drupal, WordPress und maßgeschneiderten PHP-CMS-Lösungen. CMS-Auswahl basierend auf Content-Bedürfnissen, technischen Fähigkeiten, Website-Funktionen, Wachstumsplänen. Maßgeschneiderte CMS-Entwicklung für spezifische Geschäftsprozesse und Workflows. CMS-Migration mit Content-, Medien-, Funktionalitätsübertragung ohne SEO-Verlust. Benutzerfreundliche Oberflächen für Content-Updates ohne Programmierkenntnisse. Mehrsprachige Unterstützung für globale Zielgruppen-Content-Management. Integration mit CRM, ERP, E-Mail-Tools für synchronisierte Workflows. Benutzerrollen- und Berechtigungskonfiguration plus Hosting- und Wartungsservices. Regelmäßige Updates einschließlich Sicherheitspatches, Plugin-Updates, Funktionsverbesserungen. Medienunterstützung: Bilder, Videos, Podcasts, organisierte Content-Anzeige."
            },
            {
                id: "web_design",
                category: "Webdesign-Services",
                keywords: ["webdesign", "ui", "ux", "responsives design", "mockup", "prototyp", "branding", "logo", "visuelle identität", "ecommerce-design", "unternehmensdesign", "portfolio", "minimalistisch", "landingpage", "mobilfreundlich", "theme-design"],
                priority: 2,
                content: "Maßgeschneidertes Website-Design, responsives Design, E-Commerce-Seiten, CMS-Plattformen, UX/UI-Design, Redesigns. Projekterfahrung umfasst responsive Websites, kreatives E-Commerce-Shop-Design, Unternehmens- und Portfolio-Websites, minimalistische Produktwebsites, UX/UI-Redesigns, Landingpages, mobilfreundliche Layouts und maßgeschneidertes Theme-Design für Plattformen wie Shopify, WooCommerce und Wix. Neue Website-Erstellung und bestehende Website-Redesigns passend zu Marke und Stil. Mobile-First-responsives Design für Smartphones, Tablets, konsistente Benutzererfahrung. Maßgeschneiderte Designs (keine Vorlagen) für einzigartige Layouts und bessere Benutzererfahrung. Interaktive Funktionen: Kontaktformulare, Live-Chat, Buchungssysteme, Terminplanung. Technologien: HTML, CSS, JavaScript, React, Angular, Vue.js, SASS, Shopify, Magento, Drupal. Design-Mockups und Prototypen für Feedback und Genehmigung vor Entwicklung. Marketing-Landingpages, Logos, Branding-Elemente mit konsistenter visueller Identität. Aktuelle Design-Trends folgend mit Überarbeitungsmöglichkeiten bis zur Zufriedenheit."
            },
            {
                id: "developer_hiring",
                category: "Entwickler-Einstellungsservices",
                keywords: ["entwickler einstellen", "dedizierter entwickler", "remote-entwickler", "entwicklerteam", "outsourcing", "personalverstärkung", "dotnet", ".net", "angular", "laravel", "php", "python", "mobil", "design"],
                priority: 2,
                content: "Web-, Mobil-, Cloud-Technologie-Entwickler einschließlich Front-End-, Back-End-, Full-Stack-Spezialisten. Technologien: .NET, PHP, Angular, React, Python, Flutter, Xamarin, Laravel, Java, JavaScript, Django, Node.js. Dedizierte Entwickler verfügbar zur Einstellung in PHP, .NET, Python, mobile Entwicklung und Design. Dedizierte Entwickler arbeiten als Erweiterung der Kundenteams für langfristige oder projektbasierte Anforderungen. Flexible Vereinbarungen: kurzfristige Projekte oder langfristige Engagements. Einzelne Entwicklereinstellung oder Team-Skalierungsoptionen. Skill-Matching mit Projektanforderungen, Erfahrungsüberprüfung, Beispiele vergangener Arbeiten. Entwickler-Interviews und Bewertung vor Einstellungsentscheidungen. Zeitzonen-Flexibilität mit signifikanter Überlappung und koordinierter Kommunikation. Schnelle Entwicklerbereitstellung (wenige Tage) mit effizienter Einarbeitung. Team-Erweiterungsfähigkeit mit dediziertem Projektfokus. Entwickler-Austausch, wenn Erwartungen nicht erfüllt werden. Inhouse-Team-Integration und Zusammenarbeit. Flexible Einstellung: stündlich, monatlich, festpreisbasiertes Projekt."
            },
            {
                id: "membership_management",
                category: "Mitgliedschaftsverwaltungssoftware",
                keywords: ["mitgliedschaft", "mitglied", "verlängerung", "abonnement", "gemeinschaft", "organisation", "verband", "club", "benutzerregistrierung", "rollenbasierter zugriff", "veranstaltungsverwaltung"],
                priority: 3,
                content: "Verwaltet Mitglieder, verfolgt Verlängerungen, verarbeitet Zahlungen, sendet Benachrichtigungen, organisiert Veranstaltungen. Projekterfahrung umfasst Mitgliedschaftsverwaltungsplattformen für Verbände, Clubs und Gemeinschaften mit Benutzerregistrierung, Abonnementbehandlung, Zahlungsverarbeitung, Verlängerungen, rollenbasiertem Zugriff und Veranstaltungsverwaltung. Unterstützt mehrere Mitgliedschaftsebenen (Basis, Premium, VIP) mit unterschiedlichen Vorteilen, Gebühren und Zugriff. Einfaches Hinzufügen/Aktualisieren von Mitgliedern über Admin-Portal oder Self-Service-Online-Profile. Automatische Verlängerungserinnerungen per E-Mail oder SMS vor Ablauf der Mitgliedschaft. Online-Gebührenzahlungen mit integrierten Gateways, wiederkehrende Abrechnung, mehrere Währungen, automatische Quittungen. Mitglieder-Self-Service-Profilaktualisierungen über Web oder mobile App. Sichere Datenverschlüsselung, rollenbasierte Zugriffskontrollen und Berechtigungsbeschränkungen. Berichte und Dashboards zu Mitgliederwachstum, Zahlungen, Verlängerungen, Veranstaltungsbesuch. Integration mit CRMs, E-Mail-Marketing-Tools für optimierte Kommunikation. Veranstaltungsregistrierung, Anwesenheitsverfolgung, Teilnahmeberichte, Follow-ups. CSV-Datenimport mit Feldzuordnung zur Bewahrung historischer Informationen."
            },
            {
                id: "baas_solutions",
                category: "Banking as a Service",
                keywords: ["baas", "banking", "fintech", "zahlung", "digitales banking", "api-banking", "finanzdienstleistungen", "mobile wallet", "geldtransfer", "compliance", "kernbanking", "digitales onboarding", "transaktionsverwaltung"],
                priority: 3,
                content: "API-basierte Banking-Funktionen-Integration ohne vollständige Bank-Infrastruktur. Projekterfahrung umfasst digitale Banking-Plattformen mit Online-Zahlungen, mobile Wallets, Geldtransfers, compliance-bereite Systeme, Kernbanking-Integrationen, digitales Onboarding und sichere Transaktionsverwaltung. Geeignet für Start-ups und Unternehmen jeder Größe, die Banking-Funktionen wünschen. Schnelles Setup und API-Integration (typischerweise wenige Wochen). Direkte App/Website-Integration ohne externe Portale. White-Label-Lösungen mit Ihrem Unternehmensbranding. Kernbanking-Funktionen: digitale Konten, Karten, Darlehen, Zahlungen. Internationale Zahlungen und mehrere Währungen Unterstützung. PCI-DSS- und DSGVO-Compliance mit verschlüsselter, überwachter Datenspeicherung. Kompatibel mit den meisten Standard-Zahlungssystemen, Karten, Wallets, Überweisungen. Nutzung hängt vom Geschäftstyp und lokalen Vorschriften ab."
            },
            {
                id: "ondc_integration",
                category: "ONDC-Integration",
                keywords: ["ondc", "offenes netzwerk", "digitaler handel", "marktplatz", "listung", "integration", "multi-verkäufer", "katalogintegration", "auftragsverwaltung", "logistikintegration"],
                priority: 3,
                content: "Offenes Netzwerk für digitale Handelslistung und Kundenreichweite. Projekterfahrung umfasst ONDC-konforme Plattformen, die Unternehmen ermöglichen, sich mit dem Open Network for Digital Commerce zu verbinden, Multi-Verkäufer-Marktplätze zu unterstützen, Katalogintegration, einheitliche Auftragsverwaltung, Zahlungssysteme und Logistikintegrationen. Unternehmensregistrierung über ONDC-fähige Plattformen mit Verifizierung. Integrationshilfe für bestehende Onlineshops mit API-Setup. Keine ONDC-Listungsgebühren, aber technisches Setup/Support kann Kosten haben. Schnelles Produkt-Onboarding mit Preisfestlegung, Kategorieverwaltung, Listungskonfiguration. Unterstützt verschiedene Unternehmen: Essenslieferung, Einzelhandelsware, Transport, lokale Dienstleistungen. Sichere Transaktionen mit Verschlüsselung, geschützte Auftrags- und Zahlungsinformationen. ERP- und Abrechnungssystemintegration mit automatisierter Synchronisation. Multi-regionale Reichweite über Städte und Bundesstaaten. Dashboards für Vertriebsverfolgung, Auftragsüberwachung, Leistungsmetriken."
            },
            {
                id: "ride_booking_app",
                category: "Fahrbuchungs-App-Entwicklung",
                keywords: ["fahrbuchung", "taxi-app", "uber-klon", "mitfahrgelegenheit", "fahrer-app", "passagier-app", "buchungssystem", "flottenmanagement", "gps-tracking", "versand", "saas-basiert"],
                priority: 3,
                content: "Mehrere Fahrtypen: Taxis, Bikes, P2P-Mitfahrgelegenheiten mit flexiblen Buchungsoptionen. Projekterfahrung umfasst SaaS-basierte Fahrbuchungs- und Flottenmanagement-Plattformen mit Fahrer- und Passagier-Apps, GPS-Tracking, Admin-Dashboards, Zahlungsintegration und automatisierten Versandsystemen. Native iOS- und Android-Apps sowohl für Fahrer als auch Fahrgäste. Entwicklungszeitrahmen: 60-90 Tage, Preise hängen vom Umfang ab — unser Team kann ein Angebot im Gespräch erstellen. Echtzeit-Fahrer-Tracking mit Kartenstandort und geschätzten Ankunftszeiten. In-App-Kommunikation zwischen Fahrern und Passagieren ohne persönliche Nummernfreigabe. Mehrere Zahlungsmethoden: Kredit-/Debitkarten, mobile Wallets, Bargeld mit sicherem Checkout. Surge-Pricing und Rabatt-/Aktionsverwaltung über Admin-Panel. MERN-Stack-Technologie für Web- und mobile App-Entwicklung. Mehrsprachige und Währungs-Unterstützung für globale Zugänglichkeit. Skalierbar für Hunderte bis Tausende gleichzeitiger Benutzer und Fahrer."
            },
            {
                id: "game_development",
                category: "Spieleentwicklungsservices",
                keywords: ["spiel", "gaming", "unity", "unreal", "2d", "3d", "mobiles spiel", "pc-spiel", "konsolen-spiel", "vr", "ar", "multiplayer", "interaktiv", "gamifiziertes lernen", "casino", "kartenspiel", "unterhaltungs-app"],
                priority: 3,
                content: "Mobile, PC, Konsolenspiele einschließlich 2D, 3D, AR, VR, Multiplayer, Bildung, Simulation. Projekterfahrung umfasst mobile Spiele, Multiplayer-Plattformen, interaktive Apps, gamifizierte Lernlösungen, Casino- und Kartenspiele sowie Unterhaltungs-Apps mit In-App-Käufen und AR/VR-Integration. Vollständige Spieleentwicklung von Grund auf mit Design, Entwicklung, Tests, Bereitstellung. Multi-Plattform-Entwicklung: Android, iOS, Windows, Konsolenplattformen. Bestehende Spielverbesserung und Upgrades mit erweiterten Grafiken, Funktionen, Leistung. Spiele-Engines: Unity, Unreal Engine, Cocos2d-x mit VR/AR-Entwicklung unter Verwendung von ARKit, ARCore, Oculus. KI-Integration, fortgeschrittene Grafiken, plattformübergreifende Kompatibilität. Programmiersprachen: C#, C++, Java, Kotlin, Swift, Python, JavaScript. Maßgeschneidertes Charakter- und Grafikdesign plus Soundeffekte und Musikkreation. In-App-Käufe, Abonnements, Anzeigenservice-Integration zur Monetarisierung."
            },
            {
                id: "odoo_erp",
                category: "Odoo ERP-Lösungen",
                keywords: ["odoo", "erp", "enterprise resource planning", "inventar", "finanzen", "crm-integration", "geschäftsführung"],
                priority: 3,
                content: "Lager-, Einkaufs-, Finanzverwaltung in einer zentralen Anlaufstelle mit CRM-ERP-Integration. Open-Source mit modularer Preisgestaltung (nur für benötigte Module bezahlen). Automatisierung für Berichte und Genehmigungen, wodurch sich wiederholende Arbeit reduziert wird. Unterstützung für mehrere Standorte für Unternehmen, die sich über mehrere Bundesstaaten erweitern. Inventarverfolgung und Bestellverwaltung. Rechnungsstellung und finanzielle Abwicklung. Strukturiertes Workflow-Management über US-Unternehmen."
            },
            {
                id: "learning_platforms",
                category: "Lernmanagementsysteme",
                keywords: ["lms", "lernplattform", "moodle", "elearning", "online-lernen", "bildungsplattform", "schulung", "kursverwaltung", "anwesenheitsverwaltung", "prüfungsportal", "fda thailand"],
                priority: 2,
                content: "Bauen Sie Lernplattformen, LMS, Anwesenheitsverwaltungsportale, Prüfungsportale und eLearning-Lösungen mit Moodle und maßgeschneiderten Plattformen. Projekterfahrung umfasst Moodle-Plattform für FDA Thailand. Vollständige Lernmanagementsystementwicklung mit Kursverwaltung, Studentenverfolgung, Bewertungstools, Anwesenheitsverwaltung, Prüfungsportalen, Content-Bereitstellung, Fortschrittsüberwachung und Zertifikatsverwaltung. Unterstützung für Videovorlesungen, interaktive Inhalte, Quiz, Aufgaben. Multi-User-Zugriff für Studenten, Lehrer, Administratoren. Integration mit Zahlungssystemen für kostenpflichtige Kurse. Mobil-responsives Design für Lernen auf jedem Gerät."
            },
            {
                id: "rpa_automation",
                category: "RPA & Prozessautomatisierung",
                keywords: ["rpa", "robotic process automation", "automatisierung", "uipath", "sap", "workflow-automatisierung", "verkaufsauftragsautomatisierung", "prozessautomatisierung", "ramp group"],
                priority: 2,
                content: "Bauen Sie Robotic Process Automation (RPA)-Lösungen mit RPA, UiPath, SAP und anderen Automatisierungstools. Projekterfahrung umfasst Verkaufsauftragsautomatisierung, die für Ramp Group erstellt wurde. Automatisieren Sie sich wiederholende Geschäftsprozesse, Dateneingabe, Berichterstellung, Auftragsverarbeitung, Rechnungsbehandlung, Datenmigration, Systemintegrationsaufgaben. Reduzieren Sie manuellen Aufwand und menschliche Fehler bei gleichzeitiger Steigerung der Effizienz. Integration mit bestehenden Geschäftssystemen und Workflows. Maßgeschneiderte Automatisierungslösungen, die auf spezifische Geschäftsprozesse zugeschnitten sind. Unterstützung für mehrere RPA-Plattformen und -Technologien."
            },
            {
                id: "ai_solutions",
                category: "KI-Lösungen",
                keywords: ["ki", "künstliche intelligenz", "chatbot", "sprachassistent", "maschinelles lernen", "prädiktive analytik", "computer vision"],
                priority: 2,
                content: "KI-gestützte Lösungen: Chatbots, Sprachassistenten, prädiktive Analytik, Computer-Vision-Systeme. Maßgeschneiderte KI-Entwicklung für Geschäftsautomatisierung und intelligente Entscheidungsfindung. Integration mit bestehenden Systemen und Workflows. Machine-Learning-Modelle für Datenanalyse und Prognosen."
            },
            {
                id: "project_process",
                category: "Projektprozess & Methodik",
                keywords: ["agile", "methodik", "prozess", "projektmanagement", "sprints", "kommunikation", "meetings", "verfolgung", "trello", "zoom", "teams"],
                priority: 1,
                content: "Agile Methodik mit Flexibilität für regelmäßiges Feedback. Projekte in Sprints unterteilt mit Kundenüberprüfung nach jedem. Anfangsdiskussion → detailliertes Angebot → Zuweisung eines dedizierten Projektmanagers. Jeder Kunde erhält einen dedizierten Projektmanager und direkten Zugang zum Team. Kommunikation über Zoom, Teams, E-Mail mit wöchentlichen/zweiwöchentlichen Meetings. Projektmanagement-Tools wie Trello zur Aufgabenverfolgung. Dediziertes QA-Team für funktionale, Leistungs- und Kompatibilitätstests. Kann mit bestehenden Entwicklungsteams zusammenarbeiten. Regelmäßige Fortschrittsaktualisierungen durch Meetings, E-Mails und Projektmanagement-Tools."
            },
            {
                id: "pricing_engagement",
                category: "Preisgestaltung & Engagement-Modelle",
                keywords: ["preisgestaltung", "kosten", "budget", "abrechnung", "stündlich", "festpreis", "dediziert", "zeitrahmen", "engagement", "angebot", "schätzung", "vorschlag", "kostenloses angebot"],
                priority: 1,
                content: "Preisgestaltung basierend auf Umfang, Komplexität und Dauer. Optionen: Festpreisprojekte, stündliche Abrechnung oder dedizierte Ressourcenmodelle. Arbeitet mit verschiedenen Budgetgrößen, schlägt gestaffelten Ansatz für kleinere Budgets vor. Dedizierte Entwickler verfügbar zur Einstellung (PHP, .NET, Python, mobil, Design). Durchschnittliche Zeitrahmen: Basis-Website 3-4 Wochen, komplexe Plattformen mehrere Monate. Kostenlose und unverbindliche Angebote bereitgestellt. Detaillierter Vorschlag per E-Mail innerhalb von Stunden nach Anfrage. Zeitrahmen- und Kostenschätzungen schnell nach Anforderungsdiskussion bereitgestellt."
            },
            {
                id: "technical_capabilities",
                category: "Technische Fähigkeiten",
                keywords: ["api", "integration", "migration", "legacy", "modernisierung", "drittanbieter", "sicherheit", "dokumentation", "zahlungsgateway", "stripe", "paypal", "benutzerdefinierte api", "crm-integration", "soziale medien"],
                priority: 1,
                content: "Systemintegrationen zwischen bestehenden und neuen Plattformen. API-Entwicklung und Drittanbieter-Integrationen einschließlich Zahlungsgateways (Stripe, PayPal), CRM-Systeme, Analysen, Social-Media-Plattformen. Plattformmigrationen mit minimaler Ausfallzeit. Legacy-Systemupdates und Modernisierung. Maßgeschneiderte API-Entwicklung mit Sicherheit und Dokumentation. Nahtlose Handhabung von Zahlungsgateway- und Drittanbieter-API-Integrationen. Integration mit Versand, CRM, sozialen Medien und anderen Geschäftstools."
            },
            {
                id: "support_maintenance",
                category: "Support & Wartung",
                keywords: ["support", "wartung", "updates", "fehlerbehebungen", "schulung", "sicherheit", "überwachung"],
                priority: 1,
                content: "Post-Launch-Wartung einschließlich Updates, Fehlerbehebungen und Verbesserungen. Technischer Support per E-Mail, Anrufe oder Ticket-Systeme. Mitarbeiterschulungen (online oder persönlich). Sicherheitsupdates und Schwachstellenüberwachung. Kann Projekte übernehmen, die von anderen Unternehmen entwickelt wurden."
            },
            {
                id: "industries_served",
                category: "Branchenexpertise",
                keywords: ["branche", "gesundheitswesen", "medizin", "bildung", "banking", "finanzen", "einzelhandel", "großhandel", "medien", "unterhaltung", "konsumgüter", "reisen", "immobilien", "automobil", "fertigung", "sektor"],
                priority: 1,
                content: "Umfangreiche Erfahrung in mehreren Branchen einschließlich Medizin & Gesundheitswesen, Bildung, Banking & Finanzen, Medien & Unterhaltung, Einzelhandel & Großhandel, Konsumgüter, Reisen, Immobilien, Automobil und Fertigung. Branchenspezifische Lösungen, die auf einzigartige Geschäftsanforderungen und Compliance-Bedürfnisse zugeschnitten sind. Tiefes Verständnis für sektorspezifische Herausforderungen und Chancen. Portfolio umfasst erfolgreiche Projekte für Kunden in den Bereichen Gesundheitswesen, Bildung, Finanzen, Einzelhandel und Immobilien."
            },
            {
                id: "engagement_followup",
                category: "Lead-Management & Follow-up",
                keywords: ["nicht interessiert", "nicht sicher", "nicht benötigt", "zurückkommen", "später", "nachdenken über", "calendly", "termin vereinbaren", "meeting", "kontakt", "e-mail"],
                priority: 1,
                content: "Für Interessenten, die noch nicht bereit sind, sich sofort zu verpflichten, senden Sie Calendly-Link an E-Mail-Adresse, damit sie ein Meeting zu ihrer bevorzugten Zeit planen können. Kostenlose Angebote ohne Verpflichtung verfügbar. Schnelle Antwort garantiert in weniger als 24 Stunden. Flexible Engagement-Optionen zur Berücksichtigung verschiedener Zeitpläne und Entscheidungsfindungs-Zeitrahmen."
            }
        ];

    }

    // Main retrieval method
    retrieveRelevantInfo(question, maxResults = 3, minScoreThreshold) {
        const questionLower = question.toLowerCase();
        const scoredSections = [];

        // German stop-words to exclude from content relevance matching
        const STOP_WORDS = new Set([
            'der', 'die', 'das', 'ein', 'eine', 'und', 'oder', 'aber', 'ist',
            'sind', 'hat', 'haben', 'wird', 'werden', 'kann', 'mit', 'von',
            'für', 'auf', 'aus', 'bei', 'nach', 'über', 'unter', 'zum', 'zur',
            'den', 'dem', 'des', 'dass', 'sich', 'nicht', 'auch', 'wie', 'wir',
            'sie', 'ihr', 'uns', 'was', 'noch', 'nur', 'mehr', 'schon',
        ]);

        this.knowledgeBase.forEach(section => {
            let score = 0;

            // Keyword matching with word-boundary regex
            section.keywords.forEach(keyword => {
                const escaped = keyword.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const re = new RegExp(`\\b${escaped}\\b`, 'i');
                if (re.test(questionLower)) {
                    score += 3;
                }
            });

            // Boost score based on priority (lower number = higher priority)
            score = score * (4 - section.priority);

            // Category name matching
            if (questionLower.includes(section.category.toLowerCase())) {
                score += 5;
            }

            // Content relevance (simple word matching, excluding stop-words)
            const questionWords = questionLower.split(' ').filter(word => word.length > 3 && !STOP_WORDS.has(word));
            const contentWords = section.content.toLowerCase().split(' ');
            const commonWords = questionWords.filter(word => contentWords.includes(word));
            score += commonWords.length * 0.5;

            if (score > 0) {
                scoredSections.push({
                    ...section,
                    relevanceScore: score
                });
            }
        });

        // Deduplicate by category (keep highest-scoring entry per category)
        const seenCategories = new Set();
        const deduped = scoredSections
            .sort((a, b) => b.relevanceScore - a.relevanceScore)
            .filter(section => {
                if (seenCategories.has(section.category)) return false;
                seenCategories.add(section.category);
                return true;
            });

        // Sigmoid normalization — map unbounded raw scores to 0–1 range
        const SIGMOID_K = parseFloat(process.env.KB_SCORE_SIGMOID_K) || 10;
        deduped.forEach(section => {
            section._rawRelevanceScore = section.relevanceScore;
            section.relevanceScore = section.relevanceScore / (section.relevanceScore + SIGMOID_K);
        });

        // Sort by relevance score and apply minimum score threshold (normalized scale)
        const MIN_SCORE_THRESHOLD = minScoreThreshold != null
            ? minScoreThreshold / (minScoreThreshold + SIGMOID_K)
            : 0.13;
        const topSections = deduped
            .slice(0, maxResults)
            .filter(section => section.relevanceScore >= MIN_SCORE_THRESHOLD);

        // Format output — fall back to general info if nothing clears the threshold
        if (topSections.length === 0) {
            return { text: this.getGeneralInfo(), isGeneralFallback: true };
        }

        return {
            text: topSections
                .map(section => `**${section.category.toUpperCase()}:**\n${section.content}`)
                .join('\n\n'),
            isGeneralFallback: false,
            // Sprint 6B.1 (F1): Preserve scored sections for downstream RAG guardrails
            sections: topSections.map(s => ({ content: `**${s.category.toUpperCase()}:**\n${s.content}`, relevanceScore: s.relevanceScore, _rawRelevanceScore: s._rawRelevanceScore }))
        };
    }

    // Fallback method for general queries
    getGeneralInfo() {
        const generalSections = this.knowledgeBase.filter(section => section.priority === 1);
        return generalSections
            .slice(0, 2)
            .map(section => `**${section.category.toUpperCase()}:**\n${section.content}`)
            .join('\n\n');
    }

    // Get specific category info
    getCategoryInfo(categoryKeyword) {
        const section = this.knowledgeBase.find(section =>
            section.keywords.some(keyword =>
                keyword.toLowerCase().includes(categoryKeyword.toLowerCase())
            ) || section.category.toLowerCase().includes(categoryKeyword.toLowerCase())
        );

        return section ? `**${section.category.toUpperCase()}:**\n${section.content}` : this.getGeneralInfo();
    }

    // Search by service type
    searchByService(serviceType) {
        const relevantSections = this.knowledgeBase.filter(section =>
            section.keywords.some(keyword =>
                serviceType.toLowerCase().includes(keyword.toLowerCase())
            )
        );

        if (relevantSections.length === 0) {
            return this.getGeneralInfo();
        }

        return relevantSections
            .sort((a, b) => a.priority - b.priority)
            .slice(0, 2)
            .map(section => `**${section.category.toUpperCase()}:**\n${section.content}`)
            .join('\n\n');
    }

    // Get all available services (for general "what do you do" queries)
    getAllServices() {
        const serviceSections = this.knowledgeBase.filter(section => section.priority <= 3);
        return serviceSections
            .map(section => section.category)
            .join(', ');
    }
}

module.exports = companyKnowledgeBaseGerman;