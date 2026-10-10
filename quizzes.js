// The quizzes for the five built-in courses, with their answers (`a` is the
// position of the right one). Read by the server only: it hands the questions
// out without the answers and marks what comes back. A course pack's quiz is
// in the same shape, in its .quiz.json.
module.exports = {
    infosec: {
        title: "Information Security & AUP",
        content: "Information Security ensures the Confidentiality, Integrity, and Availability (CIA) of data. You must always lock your screen when stepping away, use strong unique passwords, and never share credentials.",
        qs: [
            { q: "What should you do when stepping away from your desk?", opts: ["Leave it unlocked", "Lock your screen", "Turn off the monitor"], a: 1 },
            { q: "What does CIA stand for in security?", opts: ["Confidentiality, Integrity, Availability", "Central Intelligence Agency", "Cyber Information Access"], a: 0 },
            { q: "Can you share your password with IT support?", opts: ["Yes, to help them fix things", "Only if they ask via email", "No, never share your password"], a: 2 },
            { q: "How often should you change your passwords?", opts: ["Only when I forget them", "Never, it's too confusing", "Regularly according to company policy"], a: 2 },
            { q: "What makes a strong password?", opts: ["My dog's name", "A mix of uppercase, lowercase, numbers, and symbols", "12345678"], a: 1 },
            { q: "Can you write your password on a sticky note?", opts: ["Yes, if I hide it under the keyboard", "No, it must be memorized or stored in a password manager", "Yes, if I don't put my username on it"], a: 1 },
            { q: "What should you do with sensitive paper documents?", opts: ["Throw them in the trash", "Leave them on your desk", "Shred them in an approved shredder"], a: 2 },
            { q: "Are you allowed to install unauthorized software on your work computer?", opts: ["No, never", "Yes, if it helps me work faster", "Only if it is free"], a: 0 }
        ]
    },
    phishing: {
        title: "Phishing & Social Engineering",
        content: "Phishing is a fraudulent attempt to obtain sensitive information by disguising as a trustworthy entity. Always verify the sender's email address and never click suspicious links.",
        qs: [
            { q: "What is Phishing?", opts: ["A fun hobby", "Fraudulent emails attempting to steal data", "A network firewall"], a: 1 },
            { q: "If you receive an urgent email from the CEO asking for gift cards, you should:", opts: ["Buy them immediately", "Verify via a secondary channel (e.g. phone or slack)", "Forward it to everyone"], a: 1 },
            { q: "How can you check if a link is safe?", opts: ["Hover over it to see the actual URL", "Click it and see what happens", "Ask your coworker to click it"], a: 0 },
            { q: "What is 'Spear Phishing'?", opts: ["Fishing with a spear", "A targeted phishing attack aimed at a specific individual", "A phishing email with a very large file attached"], a: 1 },
            { q: "If an email looks like it's from HR, but the sender email is 'hr-updates@gmail.com', what is it?", opts: ["A legitimate update", "A likely phishing attempt", "A system error"], a: 1 },
            { q: "What is 'Vishing'?", opts: ["Voice Phishing over a phone call", "Video Phishing", "Visual Phishing"], a: 0 },
            { q: "What is 'Smishing'?", opts: ["Smiling Phishing", "SMS or Text Message Phishing", "Social Media Phishing"], a: 1 },
            { q: "If you accidentally click a phishing link, what should you do?", opts: ["Turn off your computer and go home", "Report it to IT immediately", "Ignore it and hope nothing happens"], a: 1 }
        ]
    },
    privacy: {
        title: "Data Privacy & Handling",
        content: "Data Privacy laws (like GDPR/CCPA) require us to protect PII (Personally Identifiable Information). Never store sensitive customer data on unauthorized personal devices.",
        qs: [
            { q: "What is PII?", opts: ["Personally Identifiable Information", "Public Internet IP", "Private Internal Intranet"], a: 0 },
            { q: "Where can you store customer data?", opts: ["On your personal phone", "Only on authorized, encrypted company systems", "In a public google doc"], a: 1 },
            { q: "If a customer asks to delete their data, we must:", opts: ["Ignore them", "Follow our data deletion protocol", "Tell them no"], a: 1 },
            { q: "Are you allowed to email sensitive customer data to your personal email account?", opts: ["Yes, to work from home", "No, never", "Only if you encrypt it first"], a: 1 },
            { q: "What does GDPR stand for?", opts: ["General Data Protection Regulation", "Global Data Privacy Rules", "General Digital Privacy Regulation"], a: 0 },
            { q: "If you find a USB drive in the parking lot, what should you do?", opts: ["Plug it in to see who it belongs to", "Take it home", "Give it to the IT/Security team without plugging it in"], a: 2 },
            { q: "Can you discuss sensitive customer information in a public coffee shop?", opts: ["Yes, if I whisper", "No, someone might overhear", "Yes, nobody will care"], a: 1 },
            { q: "Who is responsible for data privacy in our organization?", opts: ["Only the IT department", "Only the executives", "Everyone"], a: 2 }
        ]
    },
    incident: {
        title: "Incident Reporting",
        content: "A security incident is any violation of security policies. If you suspect a breach, lose a device, or click a bad link, report it to the security team IMMEDIATELY.",
        qs: [
            { q: "When should you report a suspected security incident?", opts: ["Immediately", "Next week", "Never, if it was an accident"], a: 0 },
            { q: "Who do you report incidents to?", opts: ["The janitor", "The Security/IT Team", "Social Media"], a: 1 },
            { q: "Is losing a company laptop a security incident?", opts: ["No, it's just hardware", "Yes, it must be reported immediately", "Only if it had stickers on it"], a: 1 },
            { q: "If a coworker shares their password with you, is that an incident?", opts: ["Yes, it violates our password policy", "No, they are just being helpful", "Only if I use it"], a: 0 },
            { q: "What should you do if you notice a stranger tailgating you into the office?", opts: ["Hold the door for them", "Ask them to badge in or report them to security", "Ignore them"], a: 1 },
            { q: "If you receive a ransomware pop-up on your computer, what is your first step?", opts: ["Pay the ransom", "Turn off the computer and call IT immediately", "Click the close button"], a: 1 },
            { q: "Why is it important to report incidents quickly?", opts: ["To get fired", "To minimize damage and stop the attack", "To waste IT's time"], a: 1 },
            { q: "Can you report a security incident anonymously if you are afraid of retaliation?", opts: ["Yes, through our whistleblower policy", "No, you must give your name", "Only if it is a major breach"], a: 0 }
        ]
    },
    secure_coding: {
        title: "Secure Coding (OWASP)",
        content: "Secure development is crucial for ISO 27001 compliance. You must follow the OWASP Top 10 guidelines to prevent vulnerabilities like SQL Injection, XSS, and broken authentication.",
        qs: [
            { q: "What does OWASP stand for?", opts: ["Open Web Application Security Project", "Online Web Access Security Protocol", "Open Windows Authentication Service Provider"], a: 0 },
            { q: "How do you prevent SQL Injection (SQLi)?", opts: ["By using parameterized queries or prepared statements", "By encrypting the database", "By using a strong password"], a: 0 },
            { q: "What is Cross-Site Scripting (XSS)?", opts: ["Injecting malicious scripts into trusted websites", "Crossing two network cables", "A type of physical security breach"], a: 0 },
            { q: "Should you ever hardcode API keys or passwords in source code?", opts: ["Yes, if the repository is private", "No, never. Use environment variables or a secrets manager.", "Only for testing purposes"], a: 1 },
            { q: "What is the principle of 'Least Privilege'?", opts: ["Giving users the minimum level of access necessary to do their job", "Making sure the CEO has access to everything", "Giving developers root access to production"], a: 0 },
            { q: "Why is input validation important?", opts: ["It makes the UI look better", "It ensures that untrusted data cannot harm the application or database", "It speeds up the server"], a: 1 },
            { q: "What should you do before deploying code to production?", opts: ["Nothing, just push it", "Conduct a code review and run automated security scans", "Ask the CEO for permission"], a: 1 },
            { q: "Is it safe to use outdated third-party libraries?", opts: ["No, they may contain known vulnerabilities. Keep dependencies updated.", "Yes, if they still work", "Only if they are open source"], a: 0 }
        ]
    }
};
