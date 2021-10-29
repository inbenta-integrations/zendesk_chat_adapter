/*
 * Connects Inbenta's chatbot with Zendesk Live Agents
 */
var inbentaZendeskAdapter = function(zendeskConf, zChat) {
  return function(chatbot) {
    let defaultZendeskConf = {
      preForm: true,
      getUserInfo: true,
      sendTranscript: true,
      department: '',
      accountKey: '',
      labels: {
        placeholder: 'We are processing your request, sooner you will be redirected to Zendesk chat.',
        defaultInitialUQZendesk: 'Hello'
      },
      launcherDivSelector: '.inbenta-bot__launcher'
    }
    defaultZendeskConf = mergeConf(defaultZendeskConf, zendeskConf);

    let transcriptFile;
    let transcriptFileSent = false;
    let eventsLoaded = false;

    if (defaultZendeskConf.accountKey === '') {
      throw new ReferenceError('Set up a valid zendesk account key');
    }

    chatbot.subscriptions.onDomReady(function(next) {
      if (localStorage.getItem('status')) {
        var status = localStorage.getItem('status');
        if (status === 'inbenta-bot') {
          // hide & close zendesk
          window.zE('webWidget', 'hide');
        } else if (status === 'zendesk-chat') {
          // hide inbenta launcher & show zendesk chat
          modifyInbentaLauncher();
          openZendeskChat();
          addListeners();
        }
      } else {
        localStorage.setItem('status', 'inbenta-bot');
        window.zE('webWidget', 'hide');
      }
      return next();
    });

    chatbot.subscriptions.onEscalateToAgent(function(data, next) {
      chatbot.actions.displaySystemMessage({
        message: defaultZendeskConf.labels.placeholder
      });
      if (defaultZendeskConf.getUserInfo) {
        chatbot.api.getVariables().then(function(data) {
          var params = prepareInfoVisitor(data);
          importZendeskScript(params);
        }); // get variables
      } else { // transfer chat to ZD
        importZendeskScript();
      }
      localStorage.setItem('inb-escalation-start', false);
    });

    /**
     * Look for escalationOffer directCall attribute, checkAgents and set variable
     * Remove end-form directCall on escalationStart contnet
     * @param  {[Object]}   messageData [MessageData of displayChatbotMessage action]
     * @param  {Function} next        [Callback]
     * @return {[next]}               [next]
     */
    chatbot.subscriptions.onDisplayChatbotMessage(function(messageData, next) {
      //Detect escalationOffer content
      if("attributes" in messageData && messageData.attributes !== null && 'DIRECT_CALL' in messageData.attributes && messageData.attributes.DIRECT_CALL==="escalationOffer"){
        checkAgentsZendesk(false);
      //Remove end-form direct-answer on escalationStart, but don't interrupt the action, so js_callback is executed
      }else if('flags' in messageData && messageData.flags.length > 0 && 'actions' in messageData && messageData.actions.length > 0){
        if(messageData.flags.indexOf('end-form')!==-1){
          for (var i = 0; i < messageData.actions.length; i++) {
            if('parameters' in messageData.actions[i] && 'callback' in messageData.actions[i].parameters && messageData.actions[i].parameters.callback == "escalationStart"){
              messageData.message = '';
              messageData.messageList = [];
            }
          }
        }
      }
      return next(messageData);
    });

    //detect escalationStart action, checkAgents and perform escalationStart directCall
    chatbot.subscriptions.onEscalationStart(function(escalationData, next) {
      checkAgentsZendesk(true);
    });

    /**
     * Check the status of the selected department, storing the value in variable
     */
    function checkAgentsZendesk(sendStart) {
      var status;
      if (zendeskConf.department.length > 0) {
        var departmentInfo = window.$zopim.livechat.departments.getDepartment(zendeskConf.department) || {};
        if (departmentInfo) window.$zopim.livechat.departments.setVisitorDepartment(departmentInfo.name);
        status = departmentInfo.status === 'online' || departmentInfo.status === 'away' ? 'TRUE' : 'FALSE';
      } else {
        status = 'TRUE';
      }
      chatbot.api.addVariable('agents_available', status).then(function() {
        if (sendStart && localStorage.getItem('inb-escalation-start') == 'false') {
          localStorage.setItem('inb-escalation-start', true);
          chatbot.actions.sendMessage({directCall:'escalationStart'});
        }
      });
    }

    function mergeConf(obj, src) {
      Object.keys(src).forEach(function(key) { obj[key] = src[key]; });
      return obj;
    }

    function openZendeskChat(){
      window.zE('webWidget', 'open');
      window.zE('webWidget', 'show');
    }

    function modifyInbentaLauncher(show = false) {
      var resetInterval = setInterval(function() {
        var launcher = document.querySelector(defaultZendeskConf.launcherDivSelector);
        if (show) {
          if (launcher && launcher.classList.length > 0) {
            if (!launcherIsShown(launcher)) launcher.style.removeProperty("display");
            clearInterval(resetInterval);
          }
        } else {
          if (launcher && launcher.classList.length > 0) {
            if (launcherIsShown(launcher)) launcher.setAttribute("style", "display:none");
            clearInterval(resetInterval);
          }
        }
      }, 300);
    }
    
    function launcherIsShown(launcher) {
      if (launcher.getAttribute("style") && launcher.getAttribute("style").indexOf("display:none") > -1) {
        return false;
      } else if (!launcher.getAttribute("style") || launcher.getAttribute("style").indexOf("display:none") == -1){
        return true;
      }
    }

    function addListeners() {
      zChat.on('account_status', function(event_data) {
        if (event_data === 'offline') chatbot.api.track('CHAT_NO_AGENTS', { value: true });
        localStorage.setItem('zendesk-account-status', event_data);
      });
      
      zChat.on('agent_update', function(event_data) {
        if (event_data.display_name !== undefined && !transcriptFileSent) {
          if (defaultZendeskConf.sendTranscript) sendChatTranscript();
        }
      });
      
      window.zE('webWidget:on', 'close', function() {
        var status = localStorage.getItem('zendesk-account-status');
        if (status === 'offline') {
          localStorage.setItem('status', 'inbenta-bot');
          window.zE('webWidget', 'hide');
          modifyInbentaLauncher(true);
          chatbot.actions.showConversationWindow();
        } 
      });
      
      window.zE('webWidget:on', 'chat:start', function() {
        chatbot.api.track('CHAT_ATTENDED', { value: true });
      });

      window.zE('webWidget:on', 'chat:end', function() {
        localStorage.setItem('status', 'inbenta-bot');
        window.zE('webWidget', 'hide');
        modifyInbentaLauncher(true);
        chatbot.actions.showConversationWindow();
      });
    }

    function prepareInfoVisitor(data) {
      var conversation = chatbot.actions.getConversationTranscript();
      var params = {
        email: (data.data.email_address) ? data.data.email_address.value : '',
        first_name: (data.data.first_name)? data.data.first_name.value : '',
        last_name: (data.data.last_name) ? data.data.last_name.value : '',
        inquiry: (data.data.inquiry)? data.data.inquiry.value : ''
      }
      params.display_name = params.first_name + ' ' + params.last_name;

      let transcriptText = '';
      let user = '';
      conversation.forEach(function(element) {
        user = element.user == 'guest' ? 'User' : 'Bot';
        transcriptText += user + ': ' +element.message + '\r\n';
      });
      transcriptFile = new File([transcriptText], 'chatTranscript.txt', { type: 'text/plain' });
      return params;
    }

    /**
     * [importZendeskScript import snippet from ZD]
     * @param  {Object} params [description]
     * @param  {String} file   [description]
     * @return {[type]}        [description]
     */
    function importZendeskScript(params = {}) {
      localStorage.setItem('status', 'zendesk-chat');
      window.zE(function() {
        window.$zopim(function() {
          var connectionStatus = zChat.getConnectionStatus();
          if (connectionStatus === 'closed') {
            zChat.init({
              account_key: defaultZendeskConf.accountKey
            });
            openZendeskChat();
          } else {
            openZendeskChat();
            chatbot.actions.hideConversationWindow();
            modifyInbentaLauncher();
          }
          if (!eventsLoaded) handleZendeskChat(params);
        });
      });
    }

    function handleZendeskChat(params = {}) {
      chatbot.actions.hideConversationWindow();
      prefillForm(params);
      window.zE('webWidget', 'open');

      if (!defaultZendeskConf.preForm){
        window.zE('webWidget', 'chat:send', params.inquiry || defaultZendeskConf.labels.defaultInitialUQZendesk);
      }
      
      addListeners();
      eventsLoaded = true;
      modifyInbentaLauncher();
    }

    function prefillForm(params = {}) {
      if (defaultZendeskConf.preForm) {
        window.zE('webWidget', 'prefill', {
          name: {
            value: params.display_name || '',
            readOnly: false // optional
          },
          email: {
            value: params.email || '',
            readOnly: false // optional
          },
          phone: {
            value: params.phone || '',
            readOnly: false // optional
          }
        });
      } else {
        if ('display_name' in params) {
          window.zE('webWidget', 'identify', {
            name: params.display_name || '',
            email: params.email || ''
          });
        }
      }
    }

    function sendChatTranscript() {
      window.transcriptFile = transcriptFile;
      zChat.sendFile(transcriptFile, function(err, data) {
        transcriptFileSent = true;
        if (err) {
          console.error('Error sending Transcript file');
        }
      });
    }
  } // return chatbot
} // export default
