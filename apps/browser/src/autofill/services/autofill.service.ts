import { EventCollectionService } from "@bitwarden/common/abstractions/event/event-collection.service";
import { SettingsService } from "@bitwarden/common/abstractions/settings.service";
import { UserVerificationService } from "@bitwarden/common/auth/abstractions/user-verification/user-verification.service.abstraction";
import { EventType } from "@bitwarden/common/enums";
import { FeatureFlag } from "@bitwarden/common/enums/feature-flag.enum";
import { ConfigServiceAbstraction } from "@bitwarden/common/platform/abstractions/config/config.service.abstraction";
import { LogService } from "@bitwarden/common/platform/abstractions/log.service";
import { CipherService } from "@bitwarden/common/vault/abstractions/cipher.service";
import { TotpService } from "@bitwarden/common/vault/abstractions/totp.service";
import { FieldType, UriMatchType, CipherType } from "@bitwarden/common/vault/enums";
import { CipherRepromptType } from "@bitwarden/common/vault/enums/cipher-reprompt-type";
import { CipherView } from "@bitwarden/common/vault/models/view/cipher.view";
import { FieldView } from "@bitwarden/common/vault/models/view/field.view";

import { BrowserApi } from "../../platform/browser/browser-api";
import { BrowserStateService } from "../../platform/services/abstractions/browser-state.service";
import { openVaultItemPasswordRepromptPopout } from "../../vault/popup/utils/vault-popout-window";
import { AutofillPort } from "../enums/autofill-port.enums";
import AutofillField from "../models/autofill-field";
import AutofillPageDetails from "../models/autofill-page-details";
import AutofillScript from "../models/autofill-script";
import { AutofillOverlayVisibility } from "../utils/autofill-overlay.enum";

import {
  AutoFillOptions,
  AutofillService as AutofillServiceInterface,
  FormData,
  GenerateFillScriptOptions,
  PageDetail,
} from "./abstractions/autofill.service";
import {
  AutoFillConstants,
  CreditCardAutoFillConstants,
  IdentityAutoFillConstants,
} from "./autofill-constants";

export default class AutofillService implements AutofillServiceInterface {
  private openVaultItemPasswordRepromptPopout = openVaultItemPasswordRepromptPopout;
  private openPasswordRepromptPopoutDebounce: NodeJS.Timeout;
  private currentlyOpeningPasswordRepromptPopout = false;
  private autofillScriptPortsSet = new Set<chrome.runtime.Port>();

  constructor(
    private cipherService: CipherService,
    private stateService: BrowserStateService,
    private totpService: TotpService,
    private eventCollectionService: EventCollectionService,
    private logService: LogService,
    private settingsService: SettingsService,
    private userVerificationService: UserVerificationService,
    private configService: ConfigServiceAbstraction,
  ) {}

  /**
   * Triggers on installation of the extension Handles injecting
   * content scripts into all tabs that are currently open, and
   * sets up a listener to ensure content scripts can identify
   * if the extension context has been disconnected.
   */
  async loadAutofillScriptsOnInstall() {
    BrowserApi.addListener(chrome.runtime.onConnect, this.handleInjectedScriptPortConnection);

    this.injectAutofillScriptsInAllTabs();
  }

  /**
   * Triggers a complete reload of all autofill scripts on tabs open within
   * the user's browsing session. This is done by first disconnecting all
   * existing autofill content script ports, which cleans up existing object
   * instances, and then re-injecting the autofill scripts into all tabs.
   */
  async reloadAutofillScripts() {
    this.autofillScriptPortsSet.forEach((port) => {
      port.disconnect();
      this.autofillScriptPortsSet.delete(port);
    });

    this.injectAutofillScriptsInAllTabs();
  }

  /**
   * Injects the autofill scripts into the current tab and all frames
   * found within the tab. Temporarily, will conditionally inject
   * the refactor of the core autofill script if the feature flag
   * is enabled.
   * @param {chrome.tabs.Tab} tab
   * @param {number} frameId
   * @param {boolean} triggeringOnPageLoad
   */
  async injectAutofillScripts(
    tab: chrome.tabs.Tab,
    frameId = 0,
    triggeringOnPageLoad = true,
  ): Promise<void> {
    const autofillV2 = await this.configService.getFeatureFlag<boolean>(FeatureFlag.AutofillV2);
    const autofillOverlay = await this.configService.getFeatureFlag<boolean>(
      FeatureFlag.AutofillOverlay,
    );
    let mainAutofillScript = "autofill.js";

    const isUsingAutofillOverlay =
      autofillOverlay &&
      (await this.settingsService.getAutoFillOverlayVisibility()) !== AutofillOverlayVisibility.Off;

    if (autofillV2) {
      mainAutofillScript = isUsingAutofillOverlay
        ? "bootstrap-autofill-overlay.js"
        : "bootstrap-autofill.js";
    }

    const injectedScripts = [mainAutofillScript];

    if (triggeringOnPageLoad) {
      injectedScripts.push("autofiller.js");
    } else {
      await BrowserApi.executeScriptInTab(tab.id, {
        file: "content/bootstrap-content-message-handler.js",
        runAt: "document_start",
      });
    }

    injectedScripts.push("notificationBar.js", "contextMenuHandler.js");

    for (const injectedScript of injectedScripts) {
      await BrowserApi.executeScriptInTab(tab.id, {
        file: `content/${injectedScript}`,
        frameId,
        runAt: "document_start",
      });
    }
  }

  /**
   * Gets all forms with password fields and formats the data
   * for both forms and password input elements.
   * @param {AutofillPageDetails} pageDetails
   * @returns {FormData[]}
   */
  getFormsWithPasswordFields(pageDetails: AutofillPageDetails): FormData[] {
    const formData: FormData[] = [];

    const passwordFields = AutofillService.loadPasswordFields(pageDetails, true, true, false, true);

    // TODO: this logic prevents multi-step account creation forms (that just start with email)
    // from being passed on to the notification bar content script - even if autofill.js found the form and email field.
    // ex: https://signup.live.com/
    if (passwordFields.length === 0) {
      return formData;
    }

    // Back up check for cases where there are several password fields detected,
    // but they are not all part of the form b/c of bad HTML

    // gather password fields that don't have an enclosing form
    const passwordFieldsWithoutForm = passwordFields.filter((pf) => pf.form === undefined);
    const formKeys = Object.keys(pageDetails.forms);
    const formCount = formKeys.length;

    // if we have 3 password fields and only 1 form, and there are password fields that are not within a form
    // but there is at least one password field within the form, then most likely this is a poorly built password change form
    if (passwordFields.length === 3 && formCount == 1 && passwordFieldsWithoutForm.length > 0) {
      // Only one form so get the singular form key
      const soloFormKey = formKeys[0];

      const atLeastOnePasswordFieldWithinSoloForm =
        passwordFields.filter((pf) => pf.form !== null && pf.form === soloFormKey).length > 0;

      if (atLeastOnePasswordFieldWithinSoloForm) {
        // We have a form with at least one password field,
        // so let's make an assumption that the password fields without a form are actually part of this form
        passwordFieldsWithoutForm.forEach((pf) => {
          pf.form = soloFormKey;
        });
      }
    }

    for (const formKey in pageDetails.forms) {
      // eslint-disable-next-line
      if (!pageDetails.forms.hasOwnProperty(formKey)) {
        continue;
      }

      const formPasswordFields = passwordFields.filter((pf) => formKey === pf.form);
      if (formPasswordFields.length > 0) {
        let uf = this.findUsernameField(pageDetails, formPasswordFields[0], false, false, false);
        if (uf == null) {
          // not able to find any viewable username fields. maybe there are some "hidden" ones?
          uf = this.findUsernameField(pageDetails, formPasswordFields[0], true, true, false);
        }
        formData.push({
          form: pageDetails.forms[formKey],
          password: formPasswordFields[0],
          username: uf,
          passwords: formPasswordFields,
        });
      }
    }

    return formData;
  }

  /**
   * Autofill a given tab with a given login item
   * @param {AutoFillOptions} options Instructions about the autofill operation, including tab and login item
   * @returns {Promise<string | null>} The TOTP code of the successfully autofilled login, if any
   */
  async doAutoFill(options: AutoFillOptions): Promise<string | null> {
    const tab = options.tab;
    if (!tab || !options.cipher || !options.pageDetails || !options.pageDetails.length) {
      throw new Error("Nothing to auto-fill.");
    }

    let totp: string | null = null;

    const canAccessPremium = await this.stateService.getCanAccessPremium();
    const defaultUriMatch = (await this.stateService.getDefaultUriMatch()) ?? UriMatchType.Domain;

    if (!canAccessPremium) {
      options.cipher.login.totp = null;
    }

    let didAutofill = false;
    await Promise.all(
      options.pageDetails.map(async (pd) => {
        // make sure we're still on correct tab
        if (pd.tab.id !== tab.id || pd.tab.url !== tab.url) {
          return;
        }

        const fillScript = await this.generateFillScript(pd.details, {
          skipUsernameOnlyFill: options.skipUsernameOnlyFill || false,
          onlyEmptyFields: options.onlyEmptyFields || false,
          onlyVisibleFields: options.onlyVisibleFields || false,
          fillNewPassword: options.fillNewPassword || false,
          allowTotpAutofill: options.allowTotpAutofill || false,
          cipher: options.cipher,
          tabUrl: tab.url,
          defaultUriMatch: defaultUriMatch,
        });

        if (!fillScript || !fillScript.script || !fillScript.script.length) {
          return;
        }

        if (
          fillScript.untrustedIframe &&
          options.allowUntrustedIframe != undefined &&
          !options.allowUntrustedIframe
        ) {
          this.logService.info("Auto-fill on page load was blocked due to an untrusted iframe.");
          return;
        }

        // Add a small delay between operations
        fillScript.properties.delay_between_operations = 20;

        didAutofill = true;
        if (!options.skipLastUsed) {
          this.cipherService.updateLastUsedDate(options.cipher.id);
        }

        BrowserApi.tabSendMessage(
          tab,
          {
            command: "fillForm",
            fillScript: fillScript,
            url: tab.url,
            pageDetailsUrl: pd.details.url,
          },
          { frameId: pd.frameId },
        );

        // Skip getting the TOTP code for clipboard in these cases
        if (
          options.cipher.type !== CipherType.Login ||
          totp !== null ||
          !options.cipher.login.totp ||
          (!canAccessPremium && !options.cipher.organizationUseTotp)
        ) {
          return;
        }

        totp = await this.stateService.getDisableAutoTotpCopy().then((disabled) => {
          if (!disabled) {
            return this.totpService.getCode(options.cipher.login.totp);
          }
          return null;
        });
      }),
    );

    if (didAutofill) {
      this.eventCollectionService.collect(EventType.Cipher_ClientAutofilled, options.cipher.id);
      if (totp !== null) {
        return totp;
      } else {
        return null;
      }
    } else {
      throw new Error("Did not auto-fill.");
    }
  }

  /**
   * Autofill the specified tab with the next login item from the cache
   * @param {PageDetail[]} pageDetails The data scraped from the page
   * @param {chrome.tabs.Tab} tab The tab to be autofilled
   * @param {boolean} fromCommand Whether the autofill is triggered by a keyboard shortcut (`true`) or autofill on page load (`false`)
   * @returns {Promise<string | null>} The TOTP code of the successfully autofilled login, if any
   */
  async doAutoFillOnTab(
    pageDetails: PageDetail[],
    tab: chrome.tabs.Tab,
    fromCommand: boolean,
  ): Promise<string | null> {
    let cipher: CipherView;
    if (fromCommand) {
      cipher = await this.cipherService.getNextCipherForUrl(tab.url);
    } else {
      const lastLaunchedCipher = await this.cipherService.getLastLaunchedForUrl(tab.url, true);
      if (
        lastLaunchedCipher &&
        Date.now().valueOf() - lastLaunchedCipher.localData?.lastLaunched?.valueOf() < 30000
      ) {
        cipher = lastLaunchedCipher;
      } else {
        cipher = await this.cipherService.getLastUsedForUrl(tab.url, true);
      }
    }

    if (cipher == null || (cipher.reprompt === CipherRepromptType.Password && !fromCommand)) {
      return null;
    }

    if (
      (await this.isPasswordRepromptRequired(cipher, tab)) &&
      !this.isDebouncingPasswordRepromptPopout()
    ) {
      if (fromCommand) {
        this.cipherService.updateLastUsedIndexForUrl(tab.url);
      }

      return null;
    }

    const totpCode = await this.doAutoFill({
      tab: tab,
      cipher: cipher,
      pageDetails: pageDetails,
      skipLastUsed: !fromCommand,
      skipUsernameOnlyFill: !fromCommand,
      onlyEmptyFields: !fromCommand,
      onlyVisibleFields: !fromCommand,
      fillNewPassword: fromCommand,
      allowUntrustedIframe: fromCommand,
      allowTotpAutofill: fromCommand,
    });

    // Update last used index as autofill has succeeded
    if (fromCommand) {
      this.cipherService.updateLastUsedIndexForUrl(tab.url);
    }

    return totpCode;
  }

  async isPasswordRepromptRequired(cipher: CipherView, tab: chrome.tabs.Tab): Promise<boolean> {
    const userHasMasterPasswordAndKeyHash =
      await this.userVerificationService.hasMasterPasswordAndMasterKeyHash();
    if (cipher.reprompt === CipherRepromptType.Password && userHasMasterPasswordAndKeyHash) {
      await this.openVaultItemPasswordRepromptPopout(tab, {
        cipherId: cipher.id,
        action: "autofill",
      });

      return true;
    }

    return false;
  }

  /**
   * Autofill the active tab with the next cipher from the cache
   * @param {PageDetail[]} pageDetails The data scraped from the page
   * @param {boolean} fromCommand Whether the autofill is triggered by a keyboard shortcut (`true`) or autofill on page load (`false`)
   * @returns {Promise<string | null>} The TOTP code of the successfully autofilled login, if any
   */
  async doAutoFillActiveTab(
    pageDetails: PageDetail[],
    fromCommand: boolean,
    cipherType?: CipherType,
  ): Promise<string | null> {
    if (!pageDetails[0]?.details?.fields?.length) {
      return null;
    }

    const tab = await this.getActiveTab();

    if (!tab || !tab.url) {
      return null;
    }

    if (!cipherType || cipherType === CipherType.Login) {
      return await this.doAutoFillOnTab(pageDetails, tab, fromCommand);
    }

    // Cipher is a non-login type
    const cipher: CipherView = (
      (await this.cipherService.getAllDecryptedForUrl(tab.url, [cipherType])) || []
    ).find(({ type }) => type === cipherType);

    if (!cipher || cipher.reprompt !== CipherRepromptType.None) {
      return null;
    }

    return await this.doAutoFill({
      tab: tab,
      cipher: cipher,
      pageDetails: pageDetails,
      skipLastUsed: !fromCommand,
      skipUsernameOnlyFill: !fromCommand,
      onlyEmptyFields: !fromCommand,
      onlyVisibleFields: !fromCommand,
      fillNewPassword: false,
      allowUntrustedIframe: fromCommand,
      allowTotpAutofill: false,
    });
  }

  /**
   * Gets the active tab from the current window.
   * Throws an error if no tab is found.
   * @returns {Promise<chrome.tabs.Tab>}
   * @private
   */
  private async getActiveTab(): Promise<chrome.tabs.Tab> {
    const tab = await BrowserApi.getTabFromCurrentWindow();
    if (!tab) {
      throw new Error("No tab found.");
    }

    return tab;
  }

  /**
   * Generates the autofill script for the specified page details and cipher.
   * @param {AutofillPageDetails} pageDetails
   * @param {GenerateFillScriptOptions} options
   * @returns {Promise<AutofillScript | null>}
   * @private
   */
  private async generateFillScript(
    pageDetails: AutofillPageDetails,
    options: GenerateFillScriptOptions,
  ): Promise<AutofillScript | null> {
    if (!pageDetails || !options.cipher) {
      return null;
    }

    const fillScript = new AutofillScript();
    const filledFields: { [id: string]: AutofillField } = {};
    const fields = options.cipher.fields;

    if (fields && fields.length) {
      const fieldNames: string[] = [];

      fields.forEach((f) => {
        if (AutofillService.hasValue(f.name)) {
          fieldNames.push(f.name.toLowerCase());
        }
      });

      pageDetails.fields.forEach((field) => {
        // eslint-disable-next-line
        if (filledFields.hasOwnProperty(field.opid)) {
          return;
        }

        if (!field.viewable && field.tagName !== "span") {
          return;
        }

        const matchingIndex = this.findMatchingFieldIndex(field, fieldNames);
        if (matchingIndex > -1) {
          const matchingField: FieldView = fields[matchingIndex];
          let val: string;
          if (matchingField.type === FieldType.Linked) {
            // Assumption: Linked Field is not being used to autofill a boolean value
            val = options.cipher.linkedFieldValue(matchingField.linkedId) as string;
          } else {
            val = matchingField.value;
            if (val == null && matchingField.type === FieldType.Boolean) {
              val = "false";
            }
          }

          filledFields[field.opid] = field;
          AutofillService.fillByOpid(fillScript, field, val);
        }
      });
    }

    const args: [
      AutofillScript,
      AutofillPageDetails,
      { [id: string]: AutofillField },
      GenerateFillScriptOptions,
    ] = [fillScript, pageDetails, filledFields, options];
    switch (options.cipher.type) {
      case CipherType.Login:
        return await this.generateLoginFillScript(...args);
      case CipherType.Card:
        return this.generateCardFillScript(...args);
      case CipherType.Identity:
        return this.generateIdentityFillScript(...args);
      default:
        return null;
    }
  }

  /**
   * Generates the autofill script for the specified page details and login cipher item.
   * @param {AutofillScript} fillScript
   * @param {AutofillPageDetails} pageDetails
   * @param {{[p: string]: AutofillField}} filledFields
   * @param {GenerateFillScriptOptions} options
   * @returns {Promise<AutofillScript | null>}
   * @private
   */
  private async generateLoginFillScript(
    fillScript: AutofillScript,
    pageDetails: AutofillPageDetails,
    filledFields: { [id: string]: AutofillField },
    options: GenerateFillScriptOptions,
  ): Promise<AutofillScript | null> {
    if (!options.cipher.login) {
      return null;
    }

    const passwords: AutofillField[] = [];
    const usernames: AutofillField[] = [];
    const totps: AutofillField[] = [];
    let pf: AutofillField = null;
    let username: AutofillField = null;
    let totp: AutofillField = null;
    const login = options.cipher.login;
    fillScript.savedUrls =
      login?.uris?.filter((u) => u.match != UriMatchType.Never).map((u) => u.uri) ?? [];

    fillScript.untrustedIframe = this.inUntrustedIframe(pageDetails.url, options);

    let passwordFields = AutofillService.loadPasswordFields(
      pageDetails,
      false,
      false,
      options.onlyEmptyFields,
      options.fillNewPassword,
    );
    if (!passwordFields.length && !options.onlyVisibleFields) {
      // not able to find any viewable password fields. maybe there are some "hidden" ones?
      passwordFields = AutofillService.loadPasswordFields(
        pageDetails,
        true,
        true,
        options.onlyEmptyFields,
        options.fillNewPassword,
      );
    }

    for (const formKey in pageDetails.forms) {
      // eslint-disable-next-line
      if (!pageDetails.forms.hasOwnProperty(formKey)) {
        continue;
      }

      passwordFields.forEach((passField) => {
        pf = passField;
        passwords.push(pf);

        if (login.username) {
          username = this.findUsernameField(pageDetails, pf, false, false, false);

          if (!username && !options.onlyVisibleFields) {
            // not able to find any viewable username fields. maybe there are some "hidden" ones?
            username = this.findUsernameField(pageDetails, pf, true, true, false);
          }

          if (username) {
            usernames.push(username);
          }
        }

        if (options.allowTotpAutofill && login.totp) {
          totp = this.findTotpField(pageDetails, pf, false, false, false);

          if (!totp && !options.onlyVisibleFields) {
            // not able to find any viewable totp fields. maybe there are some "hidden" ones?
            totp = this.findTotpField(pageDetails, pf, true, true, false);
          }

          if (totp) {
            totps.push(totp);
          }
        }
      });
    }

    if (passwordFields.length && !passwords.length) {
      // The page does not have any forms with password fields. Use the first password field on the page and the
      // input field just before it as the username.

      pf = passwordFields[0];
      passwords.push(pf);

      if (login.username && pf.elementNumber > 0) {
        username = this.findUsernameField(pageDetails, pf, false, false, true);

        if (!username && !options.onlyVisibleFields) {
          // not able to find any viewable username fields. maybe there are some "hidden" ones?
          username = this.findUsernameField(pageDetails, pf, true, true, true);
        }

        if (username) {
          usernames.push(username);
        }
      }

      if (options.allowTotpAutofill && login.totp && pf.elementNumber > 0) {
        totp = this.findTotpField(pageDetails, pf, false, false, true);

        if (!totp && !options.onlyVisibleFields) {
          // not able to find any viewable username fields. maybe there are some "hidden" ones?
          totp = this.findTotpField(pageDetails, pf, true, true, true);
        }

        if (totp) {
          totps.push(totp);
        }
      }
    }

    if (!passwordFields.length) {
      // No password fields on this page. Let's try to just fuzzy fill the username.
      pageDetails.fields.forEach((f) => {
        if (
          !options.skipUsernameOnlyFill &&
          f.viewable &&
          (f.type === "text" || f.type === "email" || f.type === "tel") &&
          AutofillService.fieldIsFuzzyMatch(f, AutoFillConstants.UsernameFieldNames)
        ) {
          usernames.push(f);
        }

        if (
          options.allowTotpAutofill &&
          f.viewable &&
          (f.type === "text" || f.type === "number") &&
          (AutofillService.fieldIsFuzzyMatch(f, AutoFillConstants.TotpFieldNames) ||
            f.autoCompleteType === "one-time-code")
        ) {
          totps.push(f);
        }
      });
    }

    usernames.forEach((u) => {
      // eslint-disable-next-line
      if (filledFields.hasOwnProperty(u.opid)) {
        return;
      }

      filledFields[u.opid] = u;
      AutofillService.fillByOpid(fillScript, u, login.username);
    });

    passwords.forEach((p) => {
      // eslint-disable-next-line
      if (filledFields.hasOwnProperty(p.opid)) {
        return;
      }

      filledFields[p.opid] = p;
      AutofillService.fillByOpid(fillScript, p, login.password);
    });

    if (options.allowTotpAutofill) {
      await Promise.all(
        totps.map(async (t) => {
          if (Object.prototype.hasOwnProperty.call(filledFields, t.opid)) {
            return;
          }

          filledFields[t.opid] = t;
          const totpValue = await this.totpService.getCode(login.totp);
          AutofillService.fillByOpid(fillScript, t, totpValue);
        }),
      );
    }

    fillScript = AutofillService.setFillScriptForFocus(filledFields, fillScript);
    return fillScript;
  }

  /**
   * Generates the autofill script for the specified page details and credit card cipher item.
   * @param {AutofillScript} fillScript
   * @param {AutofillPageDetails} pageDetails
   * @param {{[p: string]: AutofillField}} filledFields
   * @param {GenerateFillScriptOptions} options
   * @returns {AutofillScript|null}
   * @private
   */
  private generateCardFillScript(
    fillScript: AutofillScript,
    pageDetails: AutofillPageDetails,
    filledFields: { [id: string]: AutofillField },
    options: GenerateFillScriptOptions,
  ): AutofillScript | null {
    if (!options.cipher.card) {
      return null;
    }

    const fillFields: { [id: string]: AutofillField } = {};

    pageDetails.fields.forEach((f) => {
      if (AutofillService.forCustomFieldsOnly(f)) {
        return;
      }

      if (this.isExcludedType(f.type, AutoFillConstants.ExcludedAutofillTypes)) {
        return;
      }

      for (let i = 0; i < CreditCardAutoFillConstants.CardAttributes.length; i++) {
        const attr = CreditCardAutoFillConstants.CardAttributes[i];
        // eslint-disable-next-line
        if (!f.hasOwnProperty(attr) || !f[attr] || !f.viewable) {
          continue;
        }

        // ref https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill
        // ref https://developers.google.com/web/fundamentals/design-and-ux/input/forms/
        if (
          !fillFields.cardholderName &&
          AutofillService.isFieldMatch(
            f[attr],
            CreditCardAutoFillConstants.CardHolderFieldNames,
            CreditCardAutoFillConstants.CardHolderFieldNameValues,
          )
        ) {
          fillFields.cardholderName = f;
          break;
        } else if (
          !fillFields.number &&
          AutofillService.isFieldMatch(
            f[attr],
            CreditCardAutoFillConstants.CardNumberFieldNames,
            CreditCardAutoFillConstants.CardNumberFieldNameValues,
          )
        ) {
          fillFields.number = f;
          break;
        } else if (
          !fillFields.exp &&
          AutofillService.isFieldMatch(
            f[attr],
            CreditCardAutoFillConstants.CardExpiryFieldNames,
            CreditCardAutoFillConstants.CardExpiryFieldNameValues,
          )
        ) {
          fillFields.exp = f;
          break;
        } else if (
          !fillFields.expMonth &&
          AutofillService.isFieldMatch(f[attr], CreditCardAutoFillConstants.ExpiryMonthFieldNames)
        ) {
          fillFields.expMonth = f;
          break;
        } else if (
          !fillFields.expYear &&
          AutofillService.isFieldMatch(f[attr], CreditCardAutoFillConstants.ExpiryYearFieldNames)
        ) {
          fillFields.expYear = f;
          break;
        } else if (
          !fillFields.code &&
          AutofillService.isFieldMatch(f[attr], CreditCardAutoFillConstants.CVVFieldNames)
        ) {
          fillFields.code = f;
          break;
        } else if (
          !fillFields.brand &&
          AutofillService.isFieldMatch(f[attr], CreditCardAutoFillConstants.CardBrandFieldNames)
        ) {
          fillFields.brand = f;
          break;
        }
      }
    });

    const card = options.cipher.card;
    this.makeScriptAction(fillScript, card, fillFields, filledFields, "cardholderName");
    this.makeScriptAction(fillScript, card, fillFields, filledFields, "number");
    this.makeScriptAction(fillScript, card, fillFields, filledFields, "code");
    this.makeScriptAction(fillScript, card, fillFields, filledFields, "brand");

    if (fillFields.expMonth && AutofillService.hasValue(card.expMonth)) {
      let expMonth: string = card.expMonth;

      if (fillFields.expMonth.selectInfo && fillFields.expMonth.selectInfo.options) {
        let index: number = null;
        const siOptions = fillFields.expMonth.selectInfo.options;
        if (siOptions.length === 12) {
          index = parseInt(card.expMonth, null) - 1;
        } else if (siOptions.length === 13) {
          if (
            siOptions[0][0] != null &&
            siOptions[0][0] !== "" &&
            (siOptions[12][0] == null || siOptions[12][0] === "")
          ) {
            index = parseInt(card.expMonth, null) - 1;
          } else {
            index = parseInt(card.expMonth, null);
          }
        }

        if (index != null) {
          const option = siOptions[index];
          if (option.length > 1) {
            expMonth = option[1];
          }
        }
      } else if (
        (this.fieldAttrsContain(fillFields.expMonth, "mm") ||
          fillFields.expMonth.maxLength === 2) &&
        expMonth.length === 1
      ) {
        expMonth = "0" + expMonth;
      }

      filledFields[fillFields.expMonth.opid] = fillFields.expMonth;
      AutofillService.fillByOpid(fillScript, fillFields.expMonth, expMonth);
    }

    if (fillFields.expYear && AutofillService.hasValue(card.expYear)) {
      let expYear: string = card.expYear;
      if (fillFields.expYear.selectInfo && fillFields.expYear.selectInfo.options) {
        for (let i = 0; i < fillFields.expYear.selectInfo.options.length; i++) {
          const o: [string, string] = fillFields.expYear.selectInfo.options[i];
          if (o[0] === card.expYear || o[1] === card.expYear) {
            expYear = o[1];
            break;
          }
          if (
            o[1].length === 2 &&
            card.expYear.length === 4 &&
            o[1] === card.expYear.substring(2)
          ) {
            expYear = o[1];
            break;
          }
          const colonIndex = o[1].indexOf(":");
          if (colonIndex > -1 && o[1].length > colonIndex + 1) {
            const val = o[1].substring(colonIndex + 2);
            if (val != null && val.trim() !== "" && val === card.expYear) {
              expYear = o[1];
              break;
            }
          }
        }
      } else if (
        this.fieldAttrsContain(fillFields.expYear, "yyyy") ||
        fillFields.expYear.maxLength === 4
      ) {
        if (expYear.length === 2) {
          expYear = "20" + expYear;
        }
      } else if (
        this.fieldAttrsContain(fillFields.expYear, "yy") ||
        fillFields.expYear.maxLength === 2
      ) {
        if (expYear.length === 4) {
          expYear = expYear.substr(2);
        }
      }

      filledFields[fillFields.expYear.opid] = fillFields.expYear;
      AutofillService.fillByOpid(fillScript, fillFields.expYear, expYear);
    }

    if (
      fillFields.exp &&
      AutofillService.hasValue(card.expMonth) &&
      AutofillService.hasValue(card.expYear)
    ) {
      const fullMonth = ("0" + card.expMonth).slice(-2);

      let fullYear: string = card.expYear;
      let partYear: string = null;
      if (fullYear.length === 2) {
        partYear = fullYear;
        fullYear = "20" + fullYear;
      } else if (fullYear.length === 4) {
        partYear = fullYear.substr(2, 2);
      }

      let exp: string = null;
      for (let i = 0; i < CreditCardAutoFillConstants.MonthAbbr.length; i++) {
        if (
          this.fieldAttrsContain(
            fillFields.exp,
            CreditCardAutoFillConstants.MonthAbbr[i] +
              "/" +
              CreditCardAutoFillConstants.YearAbbrLong[i],
          )
        ) {
          exp = fullMonth + "/" + fullYear;
        } else if (
          this.fieldAttrsContain(
            fillFields.exp,
            CreditCardAutoFillConstants.MonthAbbr[i] +
              "/" +
              CreditCardAutoFillConstants.YearAbbrShort[i],
          ) &&
          partYear != null
        ) {
          exp = fullMonth + "/" + partYear;
        } else if (
          this.fieldAttrsContain(
            fillFields.exp,
            CreditCardAutoFillConstants.YearAbbrLong[i] +
              "/" +
              CreditCardAutoFillConstants.MonthAbbr[i],
          )
        ) {
          exp = fullYear + "/" + fullMonth;
        } else if (
          this.fieldAttrsContain(
            fillFields.exp,
            CreditCardAutoFillConstants.YearAbbrShort[i] +
              "/" +
              CreditCardAutoFillConstants.MonthAbbr[i],
          ) &&
          partYear != null
        ) {
          exp = partYear + "/" + fullMonth;
        } else if (
          this.fieldAttrsContain(
            fillFields.exp,
            CreditCardAutoFillConstants.MonthAbbr[i] +
              "-" +
              CreditCardAutoFillConstants.YearAbbrLong[i],
          )
        ) {
          exp = fullMonth + "-" + fullYear;
        } else if (
          this.fieldAttrsContain(
            fillFields.exp,
            CreditCardAutoFillConstants.MonthAbbr[i] +
              "-" +
              CreditCardAutoFillConstants.YearAbbrShort[i],
          ) &&
          partYear != null
        ) {
          exp = fullMonth + "-" + partYear;
        } else if (
          this.fieldAttrsContain(
            fillFields.exp,
            CreditCardAutoFillConstants.YearAbbrLong[i] +
              "-" +
              CreditCardAutoFillConstants.MonthAbbr[i],
          )
        ) {
          exp = fullYear + "-" + fullMonth;
        } else if (
          this.fieldAttrsContain(
            fillFields.exp,
            CreditCardAutoFillConstants.YearAbbrShort[i] +
              "-" +
              CreditCardAutoFillConstants.MonthAbbr[i],
          ) &&
          partYear != null
        ) {
          exp = partYear + "-" + fullMonth;
        } else if (
          this.fieldAttrsContain(
            fillFields.exp,
            CreditCardAutoFillConstants.YearAbbrLong[i] + CreditCardAutoFillConstants.MonthAbbr[i],
          )
        ) {
          exp = fullYear + fullMonth;
        } else if (
          this.fieldAttrsContain(
            fillFields.exp,
            CreditCardAutoFillConstants.YearAbbrShort[i] + CreditCardAutoFillConstants.MonthAbbr[i],
          ) &&
          partYear != null
        ) {
          exp = partYear + fullMonth;
        } else if (
          this.fieldAttrsContain(
            fillFields.exp,
            CreditCardAutoFillConstants.MonthAbbr[i] + CreditCardAutoFillConstants.YearAbbrLong[i],
          )
        ) {
          exp = fullMonth + fullYear;
        } else if (
          this.fieldAttrsContain(
            fillFields.exp,
            CreditCardAutoFillConstants.MonthAbbr[i] + CreditCardAutoFillConstants.YearAbbrShort[i],
          ) &&
          partYear != null
        ) {
          exp = fullMonth + partYear;
        }

        if (exp != null) {
          break;
        }
      }

      if (exp == null) {
        exp = fullYear + "-" + fullMonth;
      }

      this.makeScriptActionWithValue(fillScript, exp, fillFields.exp, filledFields);
    }

    return fillScript;
  }

  /**
   * Determines whether an iframe is potentially dangerous ("untrusted") to autofill
   * @param {string} pageUrl The url of the page/iframe, usually from AutofillPageDetails
   * @param {GenerateFillScriptOptions} options The GenerateFillScript options
   * @returns {boolean} `true` if the iframe is untrusted and a warning should be shown, `false` otherwise
   * @private
   */
  private inUntrustedIframe(pageUrl: string, options: GenerateFillScriptOptions): boolean {
    // If the pageUrl (from the content script) matches the tabUrl (from the sender tab), we are not in an iframe
    // This also avoids a false positive if no URI is saved and the user triggers auto-fill anyway
    if (pageUrl === options.tabUrl) {
      return false;
    }

    // Check the pageUrl against cipher URIs using the configured match detection.
    // Remember: if we are in this function, the tabUrl already matches a saved URI for the login.
    // We need to verify the pageUrl also matches.
    const equivalentDomains = this.settingsService.getEquivalentDomains(pageUrl);
    const matchesUri = options.cipher.login.matchesUri(
      pageUrl,
      equivalentDomains,
      options.defaultUriMatch,
    );
    return !matchesUri;
  }

  /**
   * Used when handling autofill on credit card fields. Determines whether
   * the field has an attribute that matches the given value.
   * @param {AutofillField} field
   * @param {string} containsVal
   * @returns {boolean}
   * @private
   */
  private fieldAttrsContain(field: AutofillField, containsVal: string): boolean {
    if (!field) {
      return false;
    }

    let doesContain = false;
    CreditCardAutoFillConstants.CardAttributesExtended.forEach((attr) => {
      // eslint-disable-next-line
      if (doesContain || !field.hasOwnProperty(attr) || !field[attr]) {
        return;
      }

      let val = field[attr];
      val = val.replace(/ /g, "").toLowerCase();
      doesContain = val.indexOf(containsVal) > -1;
    });

    return doesContain;
  }

  /**
   * Generates the autofill script for the specified page details and identify cipher item.
   * @param {AutofillScript} fillScript
   * @param {AutofillPageDetails} pageDetails
   * @param {{[p: string]: AutofillField}} filledFields
   * @param {GenerateFillScriptOptions} options
   * @returns {AutofillScript}
   * @private
   */
  private generateIdentityFillScript(
    fillScript: AutofillScript,
    pageDetails: AutofillPageDetails,
    filledFields: { [id: string]: AutofillField },
    options: GenerateFillScriptOptions,
  ): AutofillScript {
    if (!options.cipher.identity) {
      return null;
    }

    const fillFields: { [id: string]: AutofillField } = {};

    pageDetails.fields.forEach((f) => {
      if (
        AutofillService.forCustomFieldsOnly(f) ||
        this.isExcludedType(f.type, AutoFillConstants.ExcludedAutofillTypes)
      ) {
        return;
      }

      for (let i = 0; i < IdentityAutoFillConstants.IdentityAttributes.length; i++) {
        const attr = IdentityAutoFillConstants.IdentityAttributes[i];
        // eslint-disable-next-line
        if (!f.hasOwnProperty(attr) || !f[attr] || !f.viewable) {
          continue;
        }

        // ref https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#autofill
        // ref https://developers.google.com/web/fundamentals/design-and-ux/input/forms/

        // ugly because 2 different tuple types
        const fillData1: [string, [string[], string[]]][] = [
          [
            "name",
            [
              IdentityAutoFillConstants.FullNameFieldNames,
              IdentityAutoFillConstants.FullNameFieldNameValues,
            ],
          ],
          [
            "address",
            [
              IdentityAutoFillConstants.AddressFieldNames,
              IdentityAutoFillConstants.AddressFieldNameValues,
            ],
          ],
        ];
        const fillData2: [string, [string[]]][] = [
          ["firstName", [IdentityAutoFillConstants.FirstnameFieldNames]],
          ["middleName", [IdentityAutoFillConstants.MiddlenameFieldNames]],
          ["lastName", [IdentityAutoFillConstants.LastnameFieldNames]],
          ["title", [IdentityAutoFillConstants.TitleFieldNames]],
          ["email", [IdentityAutoFillConstants.EmailFieldNames]],
          ["address1", [IdentityAutoFillConstants.Address1FieldNames]],
          ["address2", [IdentityAutoFillConstants.Address2FieldNames]],
          ["address3", [IdentityAutoFillConstants.Address3FieldNames]],
          ["postalCode", [IdentityAutoFillConstants.PostalCodeFieldNames]],
          ["city", [IdentityAutoFillConstants.CityFieldNames]],
          ["state", [IdentityAutoFillConstants.StateFieldNames]],
          ["country", [IdentityAutoFillConstants.CountryFieldNames]],
          ["phone", [IdentityAutoFillConstants.PhoneFieldNames]],
          ["username", [IdentityAutoFillConstants.UserNameFieldNames]],
          ["company", [IdentityAutoFillConstants.CompanyFieldNames]],
        ];
        if (
          fillData1.some(([attrname, args]) => {
            if (!fillFields[attrname] && AutofillService.isFieldMatch(f[attr], ...args)) {
              fillFields[attrname] = f;
              return true;
            }
            return false;
          })
        ) {
          fillData2.some(([attrname, args]) => {
            if (!fillFields[attrname] && AutofillService.isFieldMatch(f[attr], ...args)) {
              fillFields[attrname] = f;
              return true;
            }
            return false;
          });
        }
      }
    });

    const identity = options.cipher.identity;
    [
      "title",
      "firstName",
      "middleName",
      "lastName",
      "address1",
      "address2",
      "address3",
      "city",
      "postalCode",
      "company",
      "email",
      "phone",
      "username",
    ].forEach((dataProp) =>
      this.makeScriptAction(fillScript, identity, fillFields, filledFields, dataProp),
    );

    let filledState = false;
    if (fillFields.state && identity.state && identity.state.length > 2) {
      const stateLower = identity.state.toLowerCase();
      const isoState =
        IdentityAutoFillConstants.IsoStates[stateLower] ||
        IdentityAutoFillConstants.IsoProvinces[stateLower];
      if (isoState) {
        filledState = true;
        this.makeScriptActionWithValue(fillScript, isoState, fillFields.state, filledFields);
      }
    }

    if (!filledState) {
      this.makeScriptAction(fillScript, identity, fillFields, filledFields, "state");
    }

    let filledCountry = false;
    if (fillFields.country && identity.country && identity.country.length > 2) {
      const countryLower = identity.country.toLowerCase();
      const isoCountry = IdentityAutoFillConstants.IsoCountries[countryLower];
      if (isoCountry) {
        filledCountry = true;
        this.makeScriptActionWithValue(fillScript, isoCountry, fillFields.country, filledFields);
      }
    }

    if (!filledCountry) {
      this.makeScriptAction(fillScript, identity, fillFields, filledFields, "country");
    }

    if (fillFields.name && (identity.firstName || identity.lastName)) {
      const fullName = [identity.firstName, identity.middleName, identity.lastName]
        .filter((x) => !!x)
        .join(" ");
      this.makeScriptActionWithValue(fillScript, fullName, fillFields.name, filledFields);
    }

    if (fillFields.address && AutofillService.hasValue(identity.address1)) {
      const address = [identity.address1, identity.address2, identity.address3]
        .filter((x) => !!x)
        .join(", ");
      this.makeScriptActionWithValue(fillScript, address, fillFields.address, filledFields);
    }

    return fillScript;
  }

  /**
   * Accepts an HTMLInputElement type value and a list of
   * excluded types and returns true if the type is excluded.
   * @param {string} type
   * @param {string[]} excludedTypes
   * @returns {boolean}
   * @private
   */
  private isExcludedType(type: string, excludedTypes: string[]) {
    return excludedTypes.indexOf(type) > -1;
  }

  /**
   * Accepts the value of a field, a list of possible options that define if
   * a field can be matched to a vault cipher, and a secondary optional list
   * of options that define if a field can be matched to a vault cipher. Returns
   * true if the field value matches one of the options.
   * @param {string} value
   * @param {string[]} options
   * @param {string[]} containsOptions
   * @returns {boolean}
   * @private
   */
  private static isFieldMatch(
    value: string,
    options: string[],
    containsOptions?: string[],
  ): boolean {
    value = value
      .trim()
      .toLowerCase()
      .replace(/[^a-zA-Z0-9]+/g, "");
    for (let i = 0; i < options.length; i++) {
      let option = options[i];
      const checkValueContains = containsOptions == null || containsOptions.indexOf(option) > -1;
      option = option.toLowerCase().replace(/-/g, "");
      if (value === option || (checkValueContains && value.indexOf(option) > -1)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Helper method used to create a script action for a field. Conditionally
   * accepts a fieldProp value that will be used in place of the dataProp value.
   * @param {AutofillScript} fillScript
   * @param cipherData
   * @param {{[p: string]: AutofillField}} fillFields
   * @param {{[p: string]: AutofillField}} filledFields
   * @param {string} dataProp
   * @param {string} fieldProp
   * @private
   */
  private makeScriptAction(
    fillScript: AutofillScript,
    cipherData: any,
    fillFields: { [id: string]: AutofillField },
    filledFields: { [id: string]: AutofillField },
    dataProp: string,
    fieldProp?: string,
  ) {
    fieldProp = fieldProp || dataProp;
    this.makeScriptActionWithValue(
      fillScript,
      cipherData[dataProp],
      fillFields[fieldProp],
      filledFields,
    );
  }

  /**
   * Handles updating the list of filled fields and adding a script action
   * to the fill script. If a select field is passed as part of the fill options,
   * we iterate over the options to check if the passed value matches one of the
   * options. If it does, we add a script action to select the option.
   * @param {AutofillScript} fillScript
   * @param dataValue
   * @param {AutofillField} field
   * @param {{[p: string]: AutofillField}} filledFields
   * @private
   */
  private makeScriptActionWithValue(
    fillScript: AutofillScript,
    dataValue: any,
    field: AutofillField,
    filledFields: { [id: string]: AutofillField },
  ) {
    let doFill = false;
    if (AutofillService.hasValue(dataValue) && field) {
      if (field.type === "select-one" && field.selectInfo && field.selectInfo.options) {
        for (let i = 0; i < field.selectInfo.options.length; i++) {
          const option = field.selectInfo.options[i];
          for (let j = 0; j < option.length; j++) {
            if (
              AutofillService.hasValue(option[j]) &&
              option[j].toLowerCase() === dataValue.toLowerCase()
            ) {
              doFill = true;
              if (option.length > 1) {
                dataValue = option[1];
              }
              break;
            }
          }

          if (doFill) {
            break;
          }
        }
      } else {
        doFill = true;
      }
    }

    if (doFill) {
      filledFields[field.opid] = field;
      AutofillService.fillByOpid(fillScript, field, dataValue);
    }
  }

  /**
   * Accepts a pageDetails object with a list of fields and returns a list of
   * fields that are likely to be password fields.
   * @param {AutofillPageDetails} pageDetails
   * @param {boolean} canBeHidden
   * @param {boolean} canBeReadOnly
   * @param {boolean} mustBeEmpty
   * @param {boolean} fillNewPassword
   * @returns {AutofillField[]}
   */
  static loadPasswordFields(
    pageDetails: AutofillPageDetails,
    canBeHidden: boolean,
    canBeReadOnly: boolean,
    mustBeEmpty: boolean,
    fillNewPassword: boolean,
  ) {
    const arr: AutofillField[] = [];
    pageDetails.fields.forEach((f) => {
      if (AutofillService.forCustomFieldsOnly(f)) {
        return;
      }

      const isPassword = f.type === "password";
      const valueIsLikePassword = (value: string) => {
        if (value == null) {
          return false;
        }
        // Removes all whitespace, _ and - characters
        // eslint-disable-next-line
        const cleanedValue = value.toLowerCase().replace(/[\s_\-]/g, "");

        return !(
          cleanedValue.indexOf("password") < 0 ||
          AutoFillConstants.PasswordFieldIgnoreList.some((i) => cleanedValue.indexOf(i) > -1)
        );
      };
      const isLikePassword = () =>
        f.type === "text" &&
        (valueIsLikePassword(f.htmlID) ||
          valueIsLikePassword(f.htmlName) ||
          valueIsLikePassword(f.placeholder));
      if (
        !f.disabled &&
        (canBeReadOnly || !f.readonly) &&
        (isPassword || isLikePassword()) &&
        (canBeHidden || f.viewable) &&
        (!mustBeEmpty || f.value == null || f.value.trim() === "") &&
        (fillNewPassword || f.autoCompleteType !== "new-password")
      ) {
        arr.push(f);
      }
    });
    return arr;
  }

  /**
   * Accepts a pageDetails object with a list of fields and returns a list of
   * fields that are likely to be username fields.
   * @param {AutofillPageDetails} pageDetails
   * @param {AutofillField} passwordField
   * @param {boolean} canBeHidden
   * @param {boolean} canBeReadOnly
   * @param {boolean} withoutForm
   * @returns {AutofillField}
   * @private
   */
  private findUsernameField(
    pageDetails: AutofillPageDetails,
    passwordField: AutofillField,
    canBeHidden: boolean,
    canBeReadOnly: boolean,
    withoutForm: boolean,
  ): AutofillField | null {
    let usernameField: AutofillField = null;
    for (let i = 0; i < pageDetails.fields.length; i++) {
      const f = pageDetails.fields[i];
      if (AutofillService.forCustomFieldsOnly(f)) {
        continue;
      }

      if (f.elementNumber >= passwordField.elementNumber) {
        break;
      }

      if (
        !f.disabled &&
        (canBeReadOnly || !f.readonly) &&
        (withoutForm || f.form === passwordField.form) &&
        (canBeHidden || f.viewable) &&
        (f.type === "text" || f.type === "email" || f.type === "tel")
      ) {
        usernameField = f;

        if (this.findMatchingFieldIndex(f, AutoFillConstants.UsernameFieldNames) > -1) {
          // We found an exact match. No need to keep looking.
          break;
        }
      }
    }

    return usernameField;
  }

  /**
   * Accepts a pageDetails object with a list of fields and returns a list of
   * fields that are likely to be TOTP fields.
   * @param {AutofillPageDetails} pageDetails
   * @param {AutofillField} passwordField
   * @param {boolean} canBeHidden
   * @param {boolean} canBeReadOnly
   * @param {boolean} withoutForm
   * @returns {AutofillField}
   * @private
   */
  private findTotpField(
    pageDetails: AutofillPageDetails,
    passwordField: AutofillField,
    canBeHidden: boolean,
    canBeReadOnly: boolean,
    withoutForm: boolean,
  ): AutofillField | null {
    let totpField: AutofillField = null;
    for (let i = 0; i < pageDetails.fields.length; i++) {
      const f = pageDetails.fields[i];
      if (AutofillService.forCustomFieldsOnly(f)) {
        continue;
      }

      if (
        !f.disabled &&
        (canBeReadOnly || !f.readonly) &&
        (withoutForm || f.form === passwordField.form) &&
        (canBeHidden || f.viewable) &&
        (f.type === "text" || f.type === "number") &&
        AutofillService.fieldIsFuzzyMatch(f, AutoFillConstants.TotpFieldNames)
      ) {
        totpField = f;

        if (
          this.findMatchingFieldIndex(f, AutoFillConstants.TotpFieldNames) > -1 ||
          f.autoCompleteType === "one-time-code"
        ) {
          // We found an exact match. No need to keep looking.
          break;
        }
      }
    }

    return totpField;
  }

  /**
   * Accepts a field and returns the index of the first matching property
   * present in a list of attribute names.
   * @param {AutofillField} field
   * @param {string[]} names
   * @returns {number}
   * @private
   */
  private findMatchingFieldIndex(field: AutofillField, names: string[]): number {
    for (let i = 0; i < names.length; i++) {
      const proplist = [
        ["htmlID", "id"],
        ["htmlName", "name"],
        ["label-left", "label"],
        ["label-right", "label"],
        ["label-tag", "label"],
        ["label-aria", "label"],
        ["placeholder", "placeholder"],
      ];
      if (
        proplist.some(
          ([property, prefix]) =>
            (names[i].indexOf("=") > -1 &&
              this.fieldPropertyIsPrefixMatch(field, property, names[i], prefix)) ||
            this.fieldPropertyIsMatch(field, property, names[i]),
        )
      ) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Accepts a field, property, name, and prefix and returns true if the field
   * contains a value that matches the given prefixed property.
   * @param field
   * @param {string} property
   * @param {string} name
   * @param {string} prefix
   * @param {string} separator
   * @returns {boolean}
   * @private
   */
  private fieldPropertyIsPrefixMatch(
    field: any,
    property: string,
    name: string,
    prefix: string,
    separator = "=",
  ): boolean {
    if (name.indexOf(prefix + separator) === 0) {
      const sepIndex = name.indexOf(separator);
      const val = name.substring(sepIndex + 1);
      return val != null && this.fieldPropertyIsMatch(field, property, val);
    }
    return false;
  }

  /**
   * Identifies if a given property within a field matches the value
   * of the passed "name" parameter. If the name starts with "regex=",
   * the value is tested against a case-insensitive regular expression.
   * If the name starts with "csv=", the value is treated as a
   * comma-separated list of values to match.
   * @param field
   * @param {string} property
   * @param {string} name
   * @returns {boolean}
   * @private
   */
  private fieldPropertyIsMatch(field: any, property: string, name: string): boolean {
    let fieldVal = field[property] as string;
    if (!AutofillService.hasValue(fieldVal)) {
      return false;
    }

    fieldVal = fieldVal.trim().replace(/(?:\r\n|\r|\n)/g, "");
    if (name.startsWith("regex=")) {
      try {
        const regexParts = name.split("=", 2);
        if (regexParts.length === 2) {
          const regex = new RegExp(regexParts[1], "i");
          return regex.test(fieldVal);
        }
      } catch (e) {
        this.logService.error(e);
      }
    } else if (name.startsWith("csv=")) {
      const csvParts = name.split("=", 2);
      if (csvParts.length === 2) {
        const csvVals = csvParts[1].split(",");
        for (let i = 0; i < csvVals.length; i++) {
          const val = csvVals[i];
          if (val != null && val.trim().toLowerCase() === fieldVal.toLowerCase()) {
            return true;
          }
        }
        return false;
      }
    }

    return fieldVal.toLowerCase() === name;
  }

  /**
   * Accepts a field and returns true if the field contains a
   * value that matches any of the names in the provided list.
   * @param {AutofillField} field
   * @param {string[]} names
   * @returns {boolean}
   */
  static fieldIsFuzzyMatch(field: AutofillField, names: string[]): boolean {
    return [
      field.htmlID,
      field.htmlName,
      field["label-tag"],
      field.placeholder,
      field["label-left"],
      field["label-top"],
      field["label-aria"],
    ].some((param) => AutofillService.hasValue(param) && this.fuzzyMatch(names, param));
  }

  /**
   * Accepts a list of options and a value and returns
   * true if the value matches any of the options.
   * @param {string[]} options
   * @param {string} value
   * @returns {boolean}
   * @private
   */
  private static fuzzyMatch(options: string[], value: string): boolean {
    if (options == null || options.length === 0 || value == null || value === "") {
      return false;
    }

    value = value
      .replace(/(?:\r\n|\r|\n)/g, "")
      .trim()
      .toLowerCase();

    return options.some((option) => value.includes(option));
  }

  /**
   * Accepts a string and returns true if the
   * string is not falsy and not empty.
   * @param {string} str
   * @returns {boolean}
   */
  static hasValue(str: string): boolean {
    // if str is truthy, then str is not ""
    return !!str;
  }

  /**
   * Sets the `focus_by_opid` autofill script
   * action to the last field that was filled.
   * @param {{[p: string]: AutofillField}} filledFields
   * @param {AutofillScript} fillScript
   * @returns {AutofillScript}
   */
  static setFillScriptForFocus(
    filledFields: { [id: string]: AutofillField },
    fillScript: AutofillScript,
  ): AutofillScript {
    let lastField: AutofillField = null;
    let lastPasswordField: AutofillField = null;

    for (const opid in filledFields) {
      // eslint-disable-next-line
      if (filledFields.hasOwnProperty(opid) && filledFields[opid].viewable) {
        lastField = filledFields[opid];

        if (filledFields[opid].type === "password") {
          lastPasswordField = filledFields[opid];
        }
      }
    }

    // Prioritize password field over others.
    if (lastPasswordField) {
      fillScript.script.push(["focus_by_opid", lastPasswordField.opid]);
    } else if (lastField) {
      fillScript.script.push(["focus_by_opid", lastField.opid]);
    }

    return fillScript;
  }

  /**
   * Updates a fill script to place the `click_on_opid`, `focus_on_opid`, and `fill_by_opid`
   * fill script actions associated with the provided field.
   * @param {AutofillScript} fillScript
   * @param {AutofillField} field
   * @param {string} value
   */
  static fillByOpid(fillScript: AutofillScript, field: AutofillField, value: string): void {
    if (field.maxLength && value && value.length > field.maxLength) {
      value = value.substr(0, value.length);
    }
    if (field.tagName !== "span") {
      fillScript.script.push(["click_on_opid", field.opid]);
      fillScript.script.push(["focus_by_opid", field.opid]);
    }
    fillScript.script.push(["fill_by_opid", field.opid, value]);
  }

  /**
   * Identifies if the field is a custom field, a custom
   * field is defined as a field that is a `span` element.
   * @param {AutofillField} field
   * @returns {boolean}
   */
  static forCustomFieldsOnly(field: AutofillField): boolean {
    return field.tagName === "span";
  }

  /**
   * Handles debouncing the opening of the master password reprompt popout.
   */
  private isDebouncingPasswordRepromptPopout() {
    if (this.currentlyOpeningPasswordRepromptPopout) {
      return true;
    }

    this.currentlyOpeningPasswordRepromptPopout = true;
    clearTimeout(this.openPasswordRepromptPopoutDebounce);

    this.openPasswordRepromptPopoutDebounce = setTimeout(() => {
      this.currentlyOpeningPasswordRepromptPopout = false;
    }, 100);

    return false;
  }

  /**
   * Handles incoming long-lived connections from injected autofill scripts.
   * Stores the port in a set to facilitate disconnecting ports if the extension
   * needs to re-inject the autofill scripts.
   *
   * @param port - The port that was connected
   */
  private handleInjectedScriptPortConnection = (port: chrome.runtime.Port) => {
    if (port.name !== AutofillPort.InjectedScript) {
      return;
    }

    this.autofillScriptPortsSet.add(port);
    port.onDisconnect.addListener(this.handleInjectScriptPortOnDisconnect);
  };

  /**
   * Handles disconnecting ports that relate to injected autofill scripts.

   * @param port - The port that was disconnected
   */
  private handleInjectScriptPortOnDisconnect = (port: chrome.runtime.Port) => {
    if (port.name !== AutofillPort.InjectedScript) {
      return;
    }

    this.autofillScriptPortsSet.delete(port);
  };

  /**
   * Queries all open tabs in the user's browsing session
   * and injects the autofill scripts into the page.
   */
  private async injectAutofillScriptsInAllTabs() {
    const tabs = await BrowserApi.tabsQuery({});
    for (let index = 0; index < tabs.length; index++) {
      const tab = tabs[index];
      if (tab.url?.startsWith("http")) {
        this.injectAutofillScripts(tab, 0, false);
      }
    }
  }
}
