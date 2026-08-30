const catalog = {
  en: {
    welcome_help: 'SendAm can help with send money, receive money, balance, contacts, transaction history, and receipts.',
    balances_header: 'Your SendAm balances:\n{lines}',
    receive_header: 'Share one of these to receive money on SendAm:\n{lines}',
    history_empty: 'No transactions yet.',
    high_risk_warning: '⚠️ HIGH-RISK RECIPIENT DETECTED\nYou have never sent money to this address before:\nFingerprint: {fingerprint}\n\nDo you trust this recipient? Reply "YES" to confirm, or "NO" to cancel.',
    payment_confirm: 'Please confirm this payment:\nAmount: {amount} {asset}\nTo: {label}{memoLine}\nReply with your PIN to send, or "no" to cancel.',
    payment_confirm_high_risk: 'Recipient confirmed.\nPlease confirm this payment:\nAmount: {amount} {asset}\nTo: [Recipient {fingerprint}]\n{memoLine}Reply with your PIN to send, or "no" to cancel.',
    payment_cancelled: 'Payment cancelled.',
    payment_expired: 'That payment request expired. Please start again.',
    invalid_high_risk_reply: 'Invalid reply. Please reply "YES" to confirm the high-risk recipient, or "NO" to cancel.',
    pin_failed: 'PIN verification failed. Please try again or reply "no" to cancel.',
    already_processed: 'That payment was already processed or cancelled.',
    payment_success: 'Payment {status}. Receipt: {receiptId}',
    opt_out_success: 'You have unsubscribed from promotional messages. Reply START anytime to opt back in.',
    opt_in_success: 'You have opted in to receive SendAm messages and updates. Reply STOP to opt out.',
    opted_out_blocked: 'This promotional message was blocked because you are currently opted out. Reply START to receive updates.',
    lang_updated: 'Language updated to {language}.',
    window_expired_error: 'Meta customer service window expired (24h). Approved template required.',
    template_missing_error: 'Template delivery failed or template is missing/rejected.',
    invalid_destination: '"{label}" isn\'t a saved contact or a valid Stellar address. Save it first, or send to a valid address directly.',
    fallback_menu: 'I can help you send money, check balance, receive money, or show receipts.',
  },
  fr: {
    welcome_help: 'SendAm peut vous aider à envoyer de l\'argent, recevoir de l\'argent, consulter votre solde, vos contacts, l\'historique des transactions et vos reçus.',
    balances_header: 'Vos soldes SendAm :\n{lines}',
    receive_header: 'Partagez l\'une de ces adresses pour recevoir de l\'argent sur SendAm :\n{lines}',
    history_empty: 'Aucune transaction pour le moment.',
    high_risk_warning: '⚠️ DESTINATAIRE À HAUT RISQUE DÉTECTÉ\nVous n\'avez jamais envoyé d\'argent à cette adresse auparavant :\nEmpreinte : {fingerprint}\n\nFaites-vous confiance à ce destinataire ? Répondez "OUI" pour confirmer, ou "NON" pour annuler.',
    payment_confirm: 'Veuillez confirmer ce paiement :\nMontant : {amount} {asset}\nÀ : {label}{memoLine}\nRépondez avec votre code PIN pour envoyer, ou "non" pour annuler.',
    payment_confirm_high_risk: 'Destinataire confirmé.\nVeuillez confirmer ce paiement :\nMontant : {amount} {asset}\nÀ : [Destinataire {fingerprint}]\n{memoLine}Répondez avec votre code PIN pour envoyer, ou "non" pour annuler.',
    payment_cancelled: 'Paiement annulé.',
    payment_expired: 'Cette demande de paiement a expiré. Veuillez recommencer.',
    invalid_high_risk_reply: 'Réponse non valide. Veuillez répondre par "OUI" pour confirmer le destinataire à haut risque, ou "NON" pour annuler.',
    pin_failed: 'Échec de vérification du code PIN. Veuillez réessayer ou répondre "non" pour annuler.',
    already_processed: 'Ce paiement a déjà été traité ou annulé.',
    payment_success: 'Paiement {status}. Reçu : {receiptId}',
    opt_out_success: 'Vous vous êtes désabonné des messages promotionnels. Répondez START à tout moment pour vous réabonner.',
    opt_in_success: 'Vous avez accepté de recevoir les messages et mises à jour SendAm. Répondez STOP pour vous désabonner.',
    opted_out_blocked: 'Ce message promotionnel a été bloqué car vous êtes actuellement désabonné. Répondez START pour recevoir des mises à jour.',
    lang_updated: 'Langue mise à jour en {language}.',
    window_expired_error: 'La fenêtre du service client Meta a expiré (24h). Modèle approuvé requis.',
    template_missing_error: 'Échec de la livraison du modèle ou modèle manquant/rejeté.',
    invalid_destination: '"{label}" n\'est pas un contact enregistré ni une adresse Stellar valide. Enregistrez-le d\'abord ou envoyez directement à une adresse valide.',
    fallback_menu: 'Je peux vous aider à envoyer de l\'argent, consulter votre solde, recevoir de l\'argent ou afficher des reçus.',
  },
  es: {
    welcome_help: 'SendAm puede ayudarle a enviar dinero, recibir dinero, consultar saldo, contactos, historial de transacciones y recibos.',
    balances_header: 'Sus saldos de SendAm:\n{lines}',
    receive_header: 'Comparta una de estas direcciones para recibir dinero en SendAm:\n{lines}',
    history_empty: 'No hay transacciones aún.',
    high_risk_warning: '⚠️ DESTINATARIO DE ALTO RIESGO DETECTADO\nNunca ha enviado dinero a esta dirección antes:\nHuella digital: {fingerprint}\n\n¿Confía en este destinatario? Responda "SI" para confirmar, o "NO" para cancelar.',
    payment_confirm: 'Por favor confirme este pago:\nMonto: {amount} {asset}\nA: {label}{memoLine}\nResponda con su PIN para enviar, o "no" para cancelar.',
    payment_confirm_high_risk: 'Destinatario confirmado.\nPor favor confirme este pago:\nMonto: {amount} {asset}\nA: [Destinatario {fingerprint}]\n{memoLine}Responda con su PIN para enviar, o "no" para cancelar.',
    payment_cancelled: 'Pago cancelado.',
    payment_expired: 'Esa solicitud de pago ha expirado. Por favor comience de nuevo.',
    invalid_high_risk_reply: 'Respuesta no válida. Responda "SI" para confirmar el destinatario de alto riesgo, o "NO" para cancelar.',
    pin_failed: 'Error de verificación de PIN. Inténtelo de nuevo o responda "no" para cancelar.',
    already_processed: 'Ese pago ya fue procesado o cancelado.',
    payment_success: 'Pago {status}. Recibo: {receiptId}',
    opt_out_success: 'Se ha dado de baja de los mensajes promocionales. Responda START en cualquier momento para volver a suscribirse.',
    opt_in_success: 'Ha optado por recibir mensajes y actualizaciones de SendAm. Responda STOP para darse de baja.',
    opted_out_blocked: 'Este mensaje promocional fue bloqueado porque actualmente está dado de baja. Responda START para recibir actualizaciones.',
    lang_updated: 'Idioma actualizado a {language}.',
    window_expired_error: 'Ventana de servicio al cliente de Meta expirada (24h). Se requiere plantilla aprobada.',
    template_missing_error: 'Error en la entrega de la plantilla o plantilla ausente/rechazada.',
    invalid_destination: '"{label}" no es un contacto guardado ni una dirección Stellar válida. Guárdelo primero o envíe a una dirección válida directamente.',
    fallback_menu: 'Puedo ayudarle a enviar dinero, consultar saldo, recibir dinero o mostrar recibos.',
  },
};

const SUPPORTED_LOCALES = ['en', 'fr', 'es'];

const t = (key, params = {}, locale = 'en') => {
  const loc = SUPPORTED_LOCALES.includes(locale) ? locale : 'en';
  let message = (catalog[loc] && catalog[loc][key]) || (catalog['en'] && catalog['en'][key]) || key;

  for (const [paramKey, paramVal] of Object.entries(params)) {
    message = message.replaceAll(`{${paramKey}}`, paramVal != null ? String(paramVal) : '');
  }
  return message;
};

module.exports = {
  catalog,
  SUPPORTED_LOCALES,
  t,
};
