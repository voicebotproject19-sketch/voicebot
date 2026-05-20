class companyKnowledgeBaseEnglish {
    constructor() {
        // ── Per-client contact config ─────────────────────────────────────────
        // transferNumber:    human-agent line to forward calls to on handover.
        //                    null = no transfer; bot plays fallback message + sends email.
        // notificationEmail: receives handover alert whenever a call is escalated.
        // ccEmail:           always CC'd on every handover email (ops / management fallback).
        //
        // Override any value via environment variables for deployment flexibility.
        this.contact = {
            transferNumber:    process.env.company_TRANSFER_NUMBER    || null,
            notificationEmail: process.env.company_NOTIFICATION_EMAIL || 'leads@company.com',
            ccEmail:           process.env.FALLBACK_CC_EMAIL               || null,
        };
        // ─────────────────────────────────────────────────────────────────────

        this.knowledgeBase = [
            {
                id: "company_info",
                category: "General Company Information",
                keywords: ["company", "company", "about", "founded", "team", "experience", "clients", "brands", "headquarters", "noida", "usa", "projects completed", "satisfaction", "rating", "clutch", "goodfirms", "certifications", "iso", "microsoft", "eo", "ypo", "microsoft solutions partner", "shopify partner", "drupal partner", "bigcommerce partner", "wix partner", "odoo partner", "google partner", "startup", "small business", "address", "location", "office", "where", "based"],
                priority: 1,
                content: "company develops custom software, web platforms, mobile applications, e-commerce solutions, AI systems, and cloud-based applications for businesses of all sizes from startups to large enterprises. Founded in 2000, operating for 26+ years with clients across 50+ countries. Over 10,000 successful projects delivered. 60% repeat business rate. 100% client satisfaction with 4.9 out of 5 rating on Clutch and GoodFirms. Headquarters in Noida, India with offices in New York, USA. Team of 300+ full-time professionals including developers, designers, QA analysts, project managers, and support engineers. Experience across retail, healthcare, finance, education, manufacturing, and many other sectors. Works with well-known brands like Steve Madden, Dabur, Stem City USA, PayPal, Bata, YMCA, Happy Planner, Smartr365, All Here, Mother Dairy, Entrepreneurs' Organization, AwarenessIdeas4U, Ramp Group, Jetex, UNIDO LKDF, Porteck, Finding a Doctor, US Embassy SPAN Magazine, plus government and non-profit organizations. Microsoft Solutions Partner, Google Partner, Drupal Partner, Shopify Partner, BigCommerce Partner, Wix Partner, Odoo Partner. Certified to ISO 9001:2015 standards. Member of Entrepreneurs' Organization (EO) and Young Presidents' Organization (YPO). Guaranteed response in less than 24 hours."
            },
            {
                id: "portfolio_showcase",
                category: "Portfolio & Case Studies",
                keywords: ["portfolio", "work", "examples", "case studies", "steve madden", "happy planner", "smartr365", "entrepreneurs organization", "chatbot", "rpa", "fda thailand", "awarenessideas4u", "mother dairy", "all here", "ramp group"],
                priority: 1,
                content: "Recent portfolio highlights: Shopify online store for Steve Madden (USA), mobile app for Smartr365 (UK), Magento site for Happy Planner, RPA automation for Ramp Group, Moodle platform for FDA Thailand, Flutter Chatbot for Entrepreneurs' Organization, eCommerce store for AwarenessIdeas4U. Projects span healthcare, education, finance, retail, real estate industries. Hundreds of Shopify stores built including high-profile brands. Full portfolio available on website or can be emailed upon request. Success-oriented solutions that help clients meet revenue goals with complete transparency."
            },
            {
                id: "value_proposition",
                category: "Company Differentiators",
                keywords: ["different", "unique", "why choose", "advantage", "benefits", "transparency", "success", "revenue", "listen", "understand", "fast", "quick", "urgent", "deadline", "turnaround"],
                priority: 1,
                content: "Key differentiators: Listen, learn, and understand business first before building solutions. Focus on success-oriented outcomes that help meet revenue goals. Complete transparency throughout project lifecycle. 100% client satisfaction track record. Specialization in fast turnarounds with teams ready for urgent projects. Dedicated project manager for every client with direct team access. Free and no-obligation quotes provided within hours. Proven track record with big brands and complex projects across multiple industries."
            },
            {
                id: "software_development",
                category: "Custom Software Development",
                keywords: ["software", "custom software", "business application", "financial system", "accounting", "desktop", "chat platform", "dashboard", "monitoring", "workflow automation", "reporting", "asp.net", "microsoft stack", "desktop application", "enterprise solution"],
                priority: 2,
                content: "Custom business applications, financial systems, accounting software, desktop utilities, chat platforms, accessibility solutions, reporting dashboards, monitoring tools, and workflow automation systems. End-to-end development for industry-specific requirements with scalable architecture. Expert in full Microsoft stack including ASP.NET websites, desktop applications, and enterprise solutions. Technologies include modern frameworks and languages tailored to business needs. Integration capabilities with existing enterprise systems. Focus on usability, performance, and maintainability."
            },
            {
                id: "mobile_development",
                category: "Mobile App Development",
                keywords: ["mobile", "app", "android", "ios", "react native", "flutter", "xamarin", "swift", "kotlin", "java", "unity", "smartphone", "tablet", "phonegap", "chatbot", "food delivery", "healthcare app", "social networking", "booking", "streaming", "financial app", "on-demand", "native", "cross-platform"],
                priority: 2,
                content: "Native and cross-platform apps for iOS and Android using React Native, Flutter, Xamarin, PhoneGap. Technologies: Swift, Kotlin, Java, React Native, Flutter, Unity, cloud platforms. Project experience includes chatbots (like Flutter Chatbot for Entrepreneurs' Organization), food delivery apps, medical and healthcare apps (Smartr365, All Here), social networking apps, booking platforms, media streaming apps, financial apps, and on-demand service apps. Complete UI/UX design with user-friendly interfaces and engaging interactions. Industry-specific apps for healthcare, education, finance, retail, travel, automotive. Full code and design ownership transfer upon completion. Third-party API and payment gateway integration. App store publishing assistance for Google Play and Apple App Store. Regular progress updates through meetings, emails, project management tools. Existing app redesign and upgrade services with new features and performance improvements."
            },
            {
                id: "website_development",
                category: "Website Development",
                keywords: ["website", "web", "site", "portal", "responsive", "html", "css", "javascript", "php", "laravel", "node", "react", "angular", "python", "drupal", "wix", "dotnet", ".net", "corporate", "educational", "elearning", "media", "entertainment", "manufacturing", "industrial", "nonprofit", "ngo", "custom website", "web app", "redesign"],
                priority: 2,
                content: "Business websites, e-commerce stores, corporate sites, portals, educational platforms. Technologies: PHP, Laravel, Node.js, React, Angular, Python, WordPress, Drupal, Shopify, Wix, .NET, ASP.NET. Built thousands of custom websites and web applications. Project experience includes corporate websites, educational portals, eLearning platforms, media and entertainment sites, manufacturing and industrial websites, nonprofit and NGO portals, blogging platforms, and eCommerce-enabled business websites. Custom designs based on brand and goals (templates only when requested). Domain registration and web hosting assistance. Content management systems for easy self-editing. Professional content writing services. Third-party integrations: payment gateways, CRM, analytics. SEO-friendly structure and optimization. Platform migration with data and functionality preservation. Cross-browser compatibility testing. Social media integration for content sharing and engagement. Analytics integration for visitor and performance tracking. Multilingual and multi-currency website support. Web applications with custom features, user logins, dashboards, interactive functions. Branding support including logo design and visual identity. Full redesign, migration, and performance optimization services available. Average timeline: basic website 3-4 weeks, complex platforms several months."
            },
            {
                id: "ecommerce_solutions",
                category: "E-commerce Solutions",
                keywords: ["ecommerce", "e-commerce", "online store", "shopping", "shopify", "magento", "woocommerce", "bigcommerce", "opencart", "payment gateway", "paypal", "stripe", "nopcommerce", "marketplace", "fashion", "lifestyle", "health", "beauty", "b2b", "wholesale", "jewelry", "subscription shop", "steve madden", "happy planner", "awarenessideas4u", "millions revenue"],
                priority: 2,
                content: "Custom eCommerce development, platform setup, mobile apps, payment integration, multichannel support, SEO, maintenance. Technologies: Shopify, Magento, WooCommerce, BigCommerce, OpenCart, nopCommerce, Drupal, Odoo. Specialist in Shopify, Magento, BigCommerce, and custom stores. Built hundreds of Shopify stores including high-profile ones like Steve Madden and Happy Planner in USA. Launched stores that generate millions in revenue. Project experience includes online stores, multilingual marketplaces, fashion and lifestyle portals, health & beauty platforms, B2B wholesale solutions, jewelry stores, subscription-based shops, and eCommerce upgrades. Custom stores from scratch or platform customization based on requirements and budget. Secure payment gateway integration: PayPal, Stripe, Authorize.net with encrypted transactions. Mobile app development for iOS and Android with push notifications, recommendations, smooth checkout. SEO and digital marketing services including optimization, content creation, social media campaigns. Responsive design for mobile phones, tablets, desktops with cross-device compatibility. Subscription-based eCommerce with recurring payments, membership management, automated billing. CRM and ERP system integration for inventory, order, customer information synchronization."
            },
            {
                id: "cloud_solutions",
                category: "Cloud Solutions",
                keywords: ["cloud", "aws", "azure", "google cloud", "migration", "hosting", "serverless", "docker", "kubernetes", "virtualization", "infrastructure", "netsuite", "erp integration", "crm integration", "mortgage", "finance solution", "media platform", "content platform", "elearning portal", "enterprise web app", "data management"],
                priority: 2,
                content: "Remote server software, data storage, operations management for reduced costs and improved accessibility. Technologies: AWS, Azure, Google Cloud, NetSuite, Docker, Kubernetes, serverless computing, virtualization, security tools. Project experience includes SaaS applications, ERP & CRM integrations, mortgage and finance solutions, media and content platforms, eLearning portals, enterprise web apps, and secure data management systems. Public, private, hybrid, multi-cloud solutions with cost, security, performance balance. Industry specialization: healthcare, finance, education, media, retail, travel, real estate, automotive, manufacturing. Customized cloud services for specific workflows, applications, team sizes. Flexible pricing: pay-as-you-go, reserved plans, modular services. App, database, workload migration with system reconfiguration and thorough testing. Performance optimization with better processing power, memory, network resources. Peak usage handling with automatic scaling, load balancing, server optimization."
            },
            {
                id: "saas_development",
                category: "SaaS Development",
                keywords: ["saas", "software as a service", "subscription", "multi-tenant", "cloud software", "platform", "digital payment", "document management", "hr", "payroll", "advisory", "consulting", "workflow management", "marketing automation", "data-driven"],
                priority: 2,
                content: "Cloud-hosted software accessed through internet without local installation. Timeline varies: small apps (few weeks), larger platforms (several months). Technologies: AWS, Azure, Google Cloud, Python, JavaScript, React, Node.js, Docker, Kubernetes. Project experience includes SaaS platforms for digital payments, document management, HR & payroll, advisory services, consulting firms, workflow management, marketing automation, and data-driven applications. Complete SaaS development from concept to deployment with scalability, subscription handling, and multi-tenant architecture. Web and mobile versions with consistent features across platforms. Third-party API integrations: payment gateways, CRMs, analytics, social platforms. Pricing models: subscription plans, freemium, tiered, pay-as-you-go. Cloud hosting on AWS, Azure, or Google Cloud with reliable server management. Existing software migration to SaaS model with updated architecture. Comprehensive testing: functional, performance, security, usability before launch."
            },
            {
                id: "crm_solutions",
                category: "Customer Relationship Management",
                keywords: ["crm", "customer relationship", "sales", "lead", "pipeline", "customer management", "automation", "tracking", "zoho", "dynamics", "salesforce", "hubspot", "microsoft dynamics", "healthcare crm", "dealership", "real estate crm", "migration"],
                priority: 2,
                content: "Organizes customer information, tracks interactions, manages relationships. Technologies include Salesforce, Zoho, HubSpot, and Microsoft Dynamics. Project experience includes custom CRM development, migration, integration with third-party tools, sales pipeline automation, healthcare CRM systems, dealership management, real estate CRMs, and payment gateway integrations. Centralizes customer data, tracks interactions, automates tasks for improved sales. Logs calls, emails, chats in single platform for complete customer history. Suitable for businesses of all sizes with scalable features. Integration with email, billing, other tools plus automated reminders and follow-ups. Secure data storage with encryption, backups, dashboards, and sales reports. Lead tracking, automated follow-ups, pipeline management across industries. Support ticket tracking, request management, post-sale customer service. Multi-user access with real-time updates and automated task management. Cloud vs on-premise options. AI and automation features for task automation, lead scoring, sales forecasting. Marketing campaign management with lead conversion analysis."
            },
            {
                id: "cms_solutions",
                category: "Content Management Systems",
                keywords: ["cms", "content management", "wordpress", "drupal", "joomla", "custom cms", "content editing", "publishing", "php cms", "membership portal", "intranet", "content publishing", "security-focused"],
                priority: 2,
                content: "Platforms: WordPress, Drupal, Joomla, Shopify, Magento, custom CMS. Project experience includes CMS-driven websites for industries like finance, healthcare, education, retail, and media, covering content publishing platforms, membership portals, intranet systems, and security-focused websites using Joomla, Drupal, WordPress, and custom PHP CMS solutions. CMS selection based on content needs, technical skills, website features, growth plans. Custom CMS development for specific business processes and workflows. CMS migration with content, media, functionality transfer without SEO loss. User-friendly interfaces for content updates without coding skills. Multi-language support for global audience content management. Integration with CRM, ERP, email tools for synchronized workflows. User roles and permissions configuration plus hosting and maintenance services. Regular updates including security patches, plugin updates, feature improvements. Media support: images, videos, podcasts, organized content display."
            },
            {
                id: "web_design",
                category: "Web Design Services",
                keywords: ["web design", "ui", "ux", "responsive design", "mockup", "prototype", "branding", "logo", "visual identity", "ecommerce design", "corporate design", "portfolio", "minimalist", "landing page", "mobile-friendly", "theme design"],
                priority: 2,
                content: "Custom website design, responsive design, e-commerce sites, CMS platforms, UX/UI design, redesigns. Project experience includes responsive websites, creative eCommerce store design, corporate and portfolio websites, minimalist product websites, UX/UI redesigns, landing pages, mobile-friendly layouts, and custom theme design for platforms like Shopify, WooCommerce, and Wix. New website creation and existing website redesigns matching brand and style. Mobile-first responsive design for smartphones, tablets, consistent user experience. Custom designs (not templates) for unique layouts and better user experience. Interactive features: contact forms, live chat, booking systems, appointment scheduling. Technologies: HTML, CSS, JavaScript, React, Angular, Vue.js, SASS, Shopify, Magento, Drupal. Design mockups and prototypes for feedback and approval before development. Marketing landing pages, logos, branding elements with consistent visual identity. Current design trends following with revision opportunities until satisfaction."
            },
            {
                id: "developer_hiring",
                category: "Developer Hiring Services",
                keywords: ["hire developer", "dedicated developer", "remote developer", "developer team", "outsourcing", "staff augmentation", "dotnet", ".net", "angular", "laravel", "php", "python", "mobile", "design"],
                priority: 2,
                content: "Web, mobile, cloud technology developers including front-end, back-end, full-stack specialists. Technologies: .NET, PHP, Angular, React, Python, Flutter, Xamarin, Laravel, Java, JavaScript, Django, Node.js. Dedicated developers available for hire in PHP, .NET, Python, mobile development, and design. Dedicated developers working as an extension of client teams for long-term or project-based requirements. Flexible arrangements: short-term projects or long-term engagements. Individual developer hire or team scaling options. Skill matching with project requirements, experience review, past work examples. Developer interviews and evaluation before hiring decisions. Time zone flexibility with significant overlap and coordinated communication. Quick developer provision (few days) with efficient onboarding. Team expansion capability with dedicated project focus. Developer replacement if expectations not met. In-house team integration and collaboration. Flexible hiring: hourly, monthly, fixed-project basis."
            },
            {
                id: "membership_management",
                category: "Membership Management Software",
                keywords: ["membership", "member", "renewal", "subscription", "community", "organization", "association", "club", "user registration", "role-based access", "event management"],
                priority: 3,
                content: "Manages members, tracks renewals, processes payments, sends notifications, organizes events. Project experience includes membership management platforms for associations, clubs, and communities with user registration, subscription handling, payment processing, renewals, role-based access, and event management. Supports multiple membership levels (basic, premium, VIP) with different benefits, fees, and access. Simple member addition/updates through admin portal or self-service online profiles. Automatic renewal reminders via email or SMS before membership expires. Online fee payments with integrated gateways, recurring billing, multiple currencies, automatic receipts. Member self-service profile updates via web or mobile app. Secure data encryption, role-based access controls, and permission restrictions. Reports and dashboards on membership growth, payments, renewals, event attendance. Integration with CRMs, email marketing tools for streamlined communication. Event registration, attendance tracking, participation reports, follow-ups. CSV data import with field mapping to preserve historical information."
            },
            {
                id: "baas_solutions",
                category: "Banking as a Service",
                keywords: ["baas", "banking", "fintech", "payment", "digital banking", "api banking", "financial services", "mobile wallet", "fund transfer", "compliance", "core banking", "digital onboarding", "transaction management"],
                priority: 3,
                content: "API-based banking functions integration without full bank infrastructure. Project experience includes digital banking platforms with online payments, mobile wallets, fund transfers, compliance-ready systems, core banking integrations, digital onboarding, and secure transaction management. Suitable for startups and businesses of any size wanting banking features. Quick setup and API integration (typically few weeks). Direct app/website integration without external portals. White-labeled solutions with your company branding. Core banking functions: digital accounts, cards, loans, payments. International payments and multiple currency support. PCI-DSS and GDPR compliance with encrypted, monitored data storage. Compatible with most standard payment systems, cards, wallets, transfers. Usage depends on business type and local regulations."
            },
            {
                id: "ondc_integration",
                category: "ONDC Integration",
                keywords: ["ondc", "open network", "digital commerce", "marketplace", "listing", "integration", "multi-seller", "catalog integration", "order management", "logistics integration"],
                priority: 3,
                content: "Open network for digital commerce listing and customer reach. Project experience includes ONDC-compliant platforms enabling businesses to connect with the Open Network for Digital Commerce, supporting multi-seller marketplaces, catalog integration, unified order management, payment systems, and logistics integrations. Business registration through ONDC-enabled platforms with verification. Integration assistance for existing online stores with API setup. No ONDC listing fees, but technical setup/support may have costs. Quick product onboarding with price setting, category management, listing configuration. Supports various businesses: food delivery, retail goods, transportation, local services. Secure transactions with encryption, protected order data and payment information. ERP and billing system integration with automated synchronization. Multi-regional reach across cities and states. Dashboards for sales tracking, order monitoring, performance metrics."
            },
            {
                id: "ride_booking_app",
                category: "Ride Booking App Development",
                keywords: ["ride booking", "taxi app", "uber clone", "ride sharing", "driver app", "passenger app", "booking system", "fleet management", "gps tracking", "dispatch", "saas-based"],
                priority: 3,
                content: "Multiple ride types: taxis, bikes, P2P ride-sharing with flexible booking options. Project experience includes SaaS-based ride booking and fleet management platforms with driver & passenger apps, GPS tracking, admin dashboards, payment integration, and automated dispatch systems. Native iOS and Android apps for both drivers and riders. Development timeline: 60-90 days, pricing depends on scope — our team can put together a quote on the call. Real-time driver tracking with map location and estimated arrival times. In-app communication between drivers and passengers without personal number sharing. Multiple payment methods: credit/debit cards, mobile wallets, cash with secure checkout. Surge pricing and discount/promotion management through admin panel. MERN stack technology for web and mobile app development. Multi-language and currency support for global accessibility. Scalable for hundreds to thousands of concurrent users and drivers."
            },
            {
                id: "game_development",
                category: "Game Development Services",
                keywords: ["game", "gaming", "unity", "unreal", "2d", "3d", "mobile game", "pc game", "console game", "vr", "ar", "multiplayer", "interactive", "gamified learning", "casino", "card game", "entertainment app"],
                priority: 3,
                content: "Mobile, PC, console games including 2D, 3D, AR, VR, multiplayer, educational, simulation. Project experience includes mobile games, multiplayer platforms, interactive apps, gamified learning solutions, casino & card games, and entertainment apps with in-app purchases and AR/VR integration. Complete game development from scratch with design, development, testing, deployment. Multi-platform development: Android, iOS, Windows, console platforms. Existing game improvement and upgrades with enhanced graphics, features, performance. Game engines: Unity, Unreal Engine, Cocos2d-x with VR/AR development using ARKit, ARCore, Oculus. AI integration, advanced graphics, cross-platform compatibility. Programming languages: C#, C++, Java, Kotlin, Swift, Python, JavaScript. Custom character and graphics design plus sound effects and music creation. In-app purchases, subscriptions, ad service integration for monetization."
            },
            {
                id: "odoo_erp",
                category: "Odoo ERP Solutions",
                keywords: ["odoo", "erp", "enterprise resource planning", "inventory", "finance", "crm integration", "business management"],
                priority: 3,
                content: "Stock, purchase, finance management in single hub with CRM-ERP integration. Open-source with modular pricing (pay only for needed modules). Automation for reports and approvals reducing repetitive work. Multi-location operations support for businesses expanding across multiple states. Inventory tracking and purchase order management. Invoicing and financial handling. Structured workflow management across USA businesses."
            },
            {
                id: "learning_platforms",
                category: "Learning Management Systems",
                keywords: ["lms", "learning platform", "moodle", "elearning", "online learning", "education platform", "training", "course management", "attendance management", "exam portal", "fda thailand"],
                priority: 2,
                content: "Build learning platforms, LMS, attendance management portals, exam portals, and eLearning solutions using Moodle and custom platforms. Project experience includes Moodle platform for FDA Thailand. Complete learning management system development with course management, student tracking, assessment tools, attendance management, exam portals, content delivery, progress monitoring, and certification management. Support for video lectures, interactive content, quizzes, assignments. Multi-user access for students, teachers, administrators. Integration with payment systems for paid courses. Mobile-responsive design for learning on any device."
            },
            {
                id: "rpa_automation",
                category: "RPA & Process Automation",
                keywords: ["rpa", "robotic process automation", "automation", "uipath", "blue prism", "power automate", "automation anywhere", "workflow automation", "sales order automation", "process automation", "ramp group"],
                priority: 2,
                content: "Build Robotic Process Automation (RPA) solutions using Blue Prism, UiPath, Microsoft Power Automate, and Automation Anywhere. Project experience includes sales order automation created for Ramp Group. Automate repetitive business processes, data entry, report generation, order processing, invoice handling, data migration, system integration tasks. Reduce manual effort and human error while increasing efficiency. Integration with existing business systems and workflows. Custom automation solutions tailored to specific business processes. Support for multiple RPA platforms and technologies."
            },
            {
                id: "ai_solutions",
                category: "AI Solutions",
                keywords: ["ai", "artificial intelligence", "machine learning", "predictive analytics", "computer vision", "nlp", "natural language processing", "deep learning", "data science"],
                priority: 2,
                content: "Enterprise-grade AI solutions and intelligent applications that go beyond automation. Leveraging advanced machine learning, NLP, computer vision, and predictive analytics to build secure, high-performance systems. Streamline operations, enhance decision-making, and deliver personalized user experiences. Intelligent process automation and scalable AI platforms. Custom AI development for business automation and intelligent decision-making. Integration with existing systems and workflows. Machine learning models for data analysis and predictions."
            },
            {
                id: "ai_voicebot_solutions",
                category: "AI Voice Bots & Chatbot Development",
                keywords: ["voice bot", "voice bots", "voicebot", "voicebots", "chatbot", "chatbots", "ai bot", "ai bots", "conversational ai", "voice assistant", "ivr", "customer engagement", "call center", "virtual agent", "voice automation", "ai calling", "smart bot", "nlu", "speech recognition"],
                priority: 1,
                content: "Transform how your business interacts with customers through AI-powered chatbots and voicebots that deliver smarter, more human-like experiences. company's intelligent bot solutions combine advanced NLP, machine learning, and real-time analytics to enable seamless, dynamic conversations across support, sales, onboarding, and more. From simplifying complex queries to delivering personalized engagement, our AI chat and voicebots learn and evolve with every interaction, creating deeper connections and driving meaningful business outcomes. Capabilities include inbound and outbound voice automation, intelligent call routing, CRM integration, multilingual support, and real-time sentiment analysis. Platforms: custom-built solutions, integration with existing telephony and contact center systems."
            },
            {
                id: "enterprise_ai_development",
                category: "Enterprise AI Development",
                keywords: ["enterprise ai", "ai platform", "intelligent automation", "ai ecosystem", "ai integration", "ai strategy", "ai consulting", "ai transformation", "scalable ai"],
                priority: 2,
                content: "Powering smarter businesses through intelligent applications and scalable AI ecosystems that drive innovation, agility, and real-world impact. We develop enterprise-grade AI solutions that think, learn, and adapt. By leveraging advanced machine learning, NLP, computer vision, and predictive analytics, we build secure, high-performance systems that streamline operations, enhance decision-making, and deliver personalized user experiences. Whether intelligent process automation or scalable AI platforms, our solutions help future-proof your enterprise and unlock measurable business value."
            },
            {
                id: "small_business_websites",
                category: "Small Business & Startup Website Solutions",
                keywords: ["small business", "startup", "smb", "basic website", "business website", "affordable website", "starter website", "company website", "local business", "online presence", "brochure site", "landing page", "simple website", "wordpress website", "shopify website"],
                priority: 2,
                content: "Affordable, professional website solutions for small businesses and startups looking to establish or improve their online presence. CMS-based options using WordPress, Shopify, or Wix for easy self-management. Typical scope includes responsive design, contact forms, about pages, service listings, and SEO-friendly structure. Average timeline: 2-4 weeks for a standard business website. Options range from template-based quick launches to fully custom designs. Includes mobile-responsive design, basic SEO setup, Google Analytics integration, and social media links. Ongoing maintenance and content update support available. Scalable solutions that grow with your business. Free consultation to understand requirements and provide a no-obligation quote."
            },
            {
                id: "project_process",
                category: "Project Process & Methodology",
                keywords: ["agile", "methodology", "process", "project management", "sprints", "communication", "meetings", "tracking", "trello", "zoom", "teams"],
                priority: 1,
                content: "Agile methodology with flexibility for regular feedback. Projects divided into sprints with client review after each. Initial discussion → detailed proposal → dedicated project manager assignment. Every client gets dedicated project manager and direct access to team. Communication via Zoom, Teams, email with weekly/bi-weekly meetings. Project management tools like Trello for task tracking. Dedicated QA team for functional, performance, and compatibility testing. Can collaborate with existing development teams. Regular progress updates through meetings, emails, and project management tools."
            },
            {
                id: "pricing_engagement",
                category: "Pricing & Engagement Models",
                keywords: ["pricing", "cost", "budget", "billing", "hourly", "fixed price", "dedicated", "timeline", "engagement", "quote", "estimate", "proposal", "free quote"],
                priority: 1,
                content: "Pricing based on scope, complexity, and duration. Options: fixed-price projects, hourly billing, or dedicated resource models. Works with various budget sizes, suggests phased approach for smaller budgets. Dedicated developers available for hire (PHP, .NET, Python, mobile, design). Average timelines: basic website 3-4 weeks, complex platforms several months. Free and no-obligation quotes provided. Detailed proposal emailed within hours of inquiry. Timeline and cost estimates provided quickly after requirements discussion."
            },
            {
                id: "technical_capabilities",
                category: "Technical Capabilities",
                keywords: ["api", "integration", "migration", "legacy", "modernization", "third party", "security", "documentation", "payment gateway", "stripe", "paypal", "custom api", "crm integration", "social media"],
                priority: 1,
                content: "System integrations between existing and new platforms. API development and third-party integrations including payment gateways (Stripe, PayPal), CRM systems, analytics, social media platforms. Platform migrations with minimal downtime. Legacy system updates and modernization. Custom API development with security and documentation. Seamless handling of payment gateway and third-party API integrations. Integration with shipping, CRM, social media, and other business tools."
            },
            {
                id: "support_maintenance",
                category: "Support & Maintenance",
                keywords: ["support", "maintenance", "updates", "fixes", "training", "security", "monitoring"],
                priority: 1,
                content: "Post-launch maintenance including updates, fixes, and enhancements. Technical support via email, calls, or ticket systems. Staff training sessions (online or in-person). Security updates and vulnerability monitoring. Can take over projects developed by other companies."
            },
            {
                id: "industries_served",
                category: "Industry Expertise",
                keywords: ["industry", "healthcare", "medical", "education", "banking", "finance", "retail", "wholesale", "media", "entertainment", "consumer products", "travel", "real estate", "automotive", "manufacturing", "sector"],
                priority: 1,
                content: "Extensive experience across multiple industries including Medical & Healthcare, Education, Banking & Finance, Media & Entertainment, Retail & Wholesale, Consumer Products, Travel, Real Estate, Automotive, and Manufacturing. Industry-specific solutions tailored to unique business requirements and compliance needs. Deep understanding of sector-specific challenges and opportunities. Portfolio includes successful projects for clients in healthcare, education, finance, retail, and real estate sectors."
            },
            {
                id: "engagement_followup",
                category: "Lead Management & Follow-up",
                keywords: ["not interested", "not sure", "not needed", "get back", "later", "think about", "schedule", "meeting", "contact", "email", "follow up", "callback"],
                priority: 3,
                content: "For prospects who are not ready to commit immediately, we can schedule a follow-up call or send information to their email address. Free quotes available with no obligation. Quick response guaranteed in less than 24 hours. Flexible engagement options to accommodate various schedules and decision-making timelines."
            },
        ];
    }

    // Main retrieval method
    retrieveRelevantInfo(question, maxResults = 2, minScoreThreshold) {

        if (!question || typeof question !== "string") {
            return { text: this.getGeneralInfo(), isGeneralFallback: true };
        }

        // Normalize query
        const questionNormalized = question
            .toLowerCase()
            .replace(/[^\w\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        // Intent shortcut for common voice queries
        if (
            questionNormalized.includes("what do you do") ||
            questionNormalized.includes("what services") ||
            questionNormalized.includes("services do you offer") ||
            questionNormalized.includes("tell me about your company") ||
            questionNormalized.includes("about your company")
        ) {
            return this.getCategoryInfo("company");
        }

        const stopWords = [
            "what","do","you","the","and","is","are","a","an",
            "to","for","of","in","on","with","can","we","me",
            "us","our","your","please","tell","about","show"
        ];
        const questionWords = questionNormalized
            .split(" ")
            .filter(w => w.length > 3 && !stopWords.includes(w));

        const scoredSections = [];

        this.knowledgeBase.forEach(section => {

            let score = 0;

            // Keyword matching using word boundaries (with regex escape)
            section.keywords.forEach(keyword => {
                const keywordNormalized = keyword.toLowerCase();
                const escapedKeyword = keywordNormalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const regex = new RegExp(`\\b${escapedKeyword}\\b`);
                if (regex.test(questionNormalized)) {
                    score += 3;
                }
            });

            // Category matching
            const categoryRegex = new RegExp(`\\b${section.category.toLowerCase()}\\b`);
            if (categoryRegex.test(questionNormalized)) {
                score += 5;
            }

            // Content relevance scoring
            const contentNormalized = section.content.toLowerCase();
            questionWords.forEach(word => {
                if (contentNormalized.includes(word)) {
                    score += 0.75;
                }
            });

            // Priority weighting (lower priority number = higher weight)
            const priorityWeight = (1 / section.priority) * 3;
            score = score * priorityWeight;

            if (score > 0) {
                scoredSections.push({
                    ...section,
                    relevanceScore: score
                });
            }
        });

        if (scoredSections.length === 0) {
            return { text: this.getGeneralInfo(), isGeneralFallback: true };
        }

        // Step 1: initial ranking by keyword score
        const ranked = scoredSections.sort((a, b) => b.relevanceScore - a.relevanceScore);

        // Step 2: take top candidates for semantic comparison
        const candidates = ranked.slice(0, 6);

        // Step 3: lightweight semantic similarity (token overlap)
        const queryTokens = new Set(questionWords);

        candidates.forEach(section => {
            const contentTokens = new Set(
                section.content
                    .toLowerCase()
                    .replace(/[^\w\s]/g, ' ')
                    .split(' ')
                    .filter(w => w.length > 3)
            );

            let intersection = 0;
            queryTokens.forEach(token => {
                if (contentTokens.has(token)) intersection++;
            });

            const union = new Set([...queryTokens, ...contentTokens]).size || 1;
            const semanticScore = intersection / union;

            section.relevanceScore = section.relevanceScore + (semanticScore * 5);
        });

        // Step 4: final ranking after semantic boost
        const reranked = candidates.sort((a, b) => b.relevanceScore - a.relevanceScore);

        // Step 5: remove duplicate categories
        const unique = [];
        const seenCategories = new Set();

        reranked.forEach(section => {
            if (!seenCategories.has(section.category)) {
                unique.push(section);
                seenCategories.add(section.category);
            }
        });

        // Step 6: Sigmoid normalization — map unbounded raw scores to 0–1 range
        // so profile thresholds (minRelevanceScore, synthesisThreshold) work correctly.
        // K is the raw score at which normalized value = 0.5. Tunable via env var.
        const SIGMOID_K = parseFloat(process.env.KB_SCORE_SIGMOID_K) || 10;
        unique.forEach(section => {
            section._rawRelevanceScore = section.relevanceScore;
            section.relevanceScore = section.relevanceScore / (section.relevanceScore + SIGMOID_K);
        });

        // Step 7: minimum score threshold — after normalization, use a normalized-scale
        // threshold. With K=10, raw 1.5 → ~0.13, so 0.13 preserves the original intent.
        // When no override is provided, use the normalized default.
        const MIN_SCORE_THRESHOLD = minScoreThreshold != null
            ? minScoreThreshold / (minScoreThreshold + SIGMOID_K)  // normalize caller-provided threshold
            : 0.13;
        const topSections = unique
            .slice(0, maxResults)
            .filter(section => section.relevanceScore >= MIN_SCORE_THRESHOLD);

        if (topSections.length === 0) {
            return { text: this.getGeneralInfo(), isGeneralFallback: true };
        }

        return {
            text: topSections
                .map(section => `${section.category.toUpperCase()}:\n${section.content}`)
                .join('\n\n'),
            isGeneralFallback: false,
            // Sprint 6B.1 (F1): Preserve scored sections for downstream RAG guardrails
            sections: topSections.map(s => ({ content: `${s.category.toUpperCase()}:\n${s.content}`, relevanceScore: s.relevanceScore, _rawRelevanceScore: s._rawRelevanceScore }))
        };
    }

    // Fallback method for general queries
    getGeneralInfo() {
        const generalSections = this.knowledgeBase
            .filter(section => section.priority === 1)
            .slice(0, 2);

        return generalSections
            .map(section => `${section.category.toUpperCase()}:\n${section.content}`)
            .join('\n\n');
    }

    // Get specific category info
    getCategoryInfo(categoryKeyword) {
        const section = this.knowledgeBase.find(section =>
            section.keywords.some(keyword =>
                keyword.toLowerCase().includes(categoryKeyword.toLowerCase())
            ) || section.category.toLowerCase().includes(categoryKeyword.toLowerCase())
        );

        return section ? `${section.category.toUpperCase()}:\n${section.content}` : this.getGeneralInfo();
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
            .map(section => `${section.category.toUpperCase()}:\n${section.content}`)
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

module.exports = companyKnowledgeBaseEnglish;