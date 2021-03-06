const puppeteer = require('puppeteer');
const _ = require('lodash');
const csvjson = require('csvjson');
const fs = require('fs');
const fsPath = require('fs-path');
const path = require('path');
const chalk = require('chalk');
const log = console.log;
let nodeCleanup = require('node-cleanup');

require('dotenv').config();

function waitForFrame(page, frameName) {
  let fulfill;
  const promise = new Promise(x => (fulfill = x));
  checkFrame();
  return promise;

  function checkFrame() {
    const frame = page.frames().find(f => f.name() === framename);
    if (frame) fulfill(frame);
    else page.once('frameattached', checkFrame);
  }
}

const CREDENTIALS = {
  username: process.env.USERID,
  password: process.env.PASSWORD
};

const PARAMS = {
  status: process.env.STATUS_VALUE,
  searchPriceMin: process.env.SEARCH_PRICE_MIN,
  searchPriceMax: process.env.SEARCH_PRICE_MAX,
  monthsBack: process.env.MONTHS_BACK
};

let allAgentDetails = [];
let errorCount = 0;
let currentListingCount = 1;

let writeToFile = () => {
  log(chalk.bold.magenta('Preparing data for writing to CSV...'));

  let dateNow = new Date().getTime();

  allAgentDetails = _.uniqBy(allAgentDetails, 'Name');

  let csv = csvjson.toCSV(allAgentDetails, {
    headers: 'key',
    wrap: true
  });

  const instancePath = (fileName) => {
    return path.join(__dirname, `output/instances${(fileName) ? `/${fileName}`: ''}`);
  }

  const checkpointsPath = (fileName) => {
    return path.join(__dirname, `output/checkpoints${(fileName) ? `/${fileName}`: ''}`);
  }

  const outputPath = (fileName) => {
    return path.join(__dirname, `output${(fileName) ? `/${fileName}`: ''}`);
  }

  log(chalk.bold.magenta(`Writing instance data to file @ ${instancePath(`${dateNow}.csv`)}...`));
  fsPath.writeFileSync(instancePath(`${dateNow}.csv`), csv, 'utf8');
  log(chalk.bold.magenta('Successfully written to instances!'));

  log(chalk.bold.magenta('Checking if agents.csv exists...'));
  if (!fs.existsSync(outputPath('agents.csv'))) {
    log(chalk.bold.red('agents.csv NOT FOUND! Initializing...'));

    fsPath.writeFileSync(checkpointsPath(`agents-${dateNow}.csv`), csv, 'utf8'); 
    fsPath.writeFileSync(outputPath(`agents.csv`), csv, 'utf8'); 

    log(chalk.bold.magenta('Done!'));
    log('');

    log(chalk.bold.magenta('---------------------- SUMMARY ----------------------'));
    log(chalk.bold.magenta(`-> Number of NEW agents FOUND for this scrape instance: ${allAgentDetails.length}`));
  } else {
    log(chalk.bold.magenta('agents.csv FOUND! Preparing...'));      

    let data = fs.readFileSync(outputPath('agents.csv'), { encoding: 'utf8' });
    data = csvjson.toSchemaObject(data, { quote: true });

    let dataCountBefore = data.length;
    let agentsUpdatedCount = 0;

    log(chalk.bold.magenta('Updating data...'));

    allAgentDetails = _.uniqBy(allAgentDetails, 'Name');

    allAgentDetails.forEach(agent => {
      let dataAgentIndex = _.findIndex(data, dataAgent => dataAgent.Name.trim() === agent.Name.trim());

      // If agent exists, update fields
      if (dataAgentIndex > -1) {
        agentsUpdatedCount++;
        let dataAgent = data[dataAgentIndex];
        for (let key in agent) {
          // Condition to NOT REPLACE existing dataAgent if newly scraped agent has no value for it
          if (!!agent[key].trim()) {
            dataAgent[key] = agent[key];
          }
        } 
      } else {  // Agent is new, insert
        data.push(agent);
      }
    });

    let dataCountAfter = data.length;

    data = _.uniqBy(data, 'Name');

    let updatedData = csvjson.toCSV(data, {
      headers: 'key',
      wrap: true
    });

    fsPath.writeFileSync(checkpointsPath(`agents-${dateNow}.csv`), updatedData, 'utf8');     
    fsPath.writeFileSync(outputPath(`agents.csv`), updatedData, 'utf8');

    log(chalk.bold.magenta('Done!'));
    log('');

    log(chalk.bold.magenta('---------------------- SUMMARY ----------------------'));
    log(chalk.bold.magenta(`-> Number of agents BEFORE this scrape instance: ${dataCountBefore}`));
    log(chalk.bold.magenta(`-> Number of agents AFTER this scrape instance: ${dataCountAfter}`));
    log(chalk.bold.magenta(`-> Number of EXISTING (and possibly updated) agents for this scrape instance: ${agentsUpdatedCount}`));    
    log(chalk.bold.magenta(`-> Number of NEW agents FOUND for this scrape instance: ${dataCountAfter - dataCountBefore}`));
  }

  log(chalk.bold.bgRed.white('Error/Skipped count:', errorCount));
}

let scrape = async () => {
  log(chalk.bold.magenta('Checking .env parameters...'));

  log(chalk.bold.magenta('Checking Credentials parameters...'));  
  if (!CREDENTIALS.username || !CREDENTIALS.password) {
    log(chalk.bold.red('USERID or PASSWORD is not set! Terminating...'));
    process.exit(0);
  }
  log(chalk.bold.magenta('Credentials parameters OK!'));    

  log(chalk.bold.magenta('Checking ConnectMLS Search Form parameters...'));    
  if (!PARAMS.status) {
    log(chalk.bold.red('Status missing! Using Connect MLS default values.'));    
  } else if (!PARAMS.searchPriceMin) {
    log(chalk.bold.red('SEARCH_PRICE_MIN is not set! Terminating...'));
    process.exit(0);
  } else if (!PARAMS.searchPriceMax) {
    log(chalk.bold.red('SEARCH_PRICE_MAX is not set! Terminating...'));
    process.exit(0);
  } else if (!PARAMS.monthsBack) {
    log(chalk.bold.red('MONTHS_BACK is not set! Terminating...'));    
    process.exit(0);
  }
  log(chalk.bold.magenta('ConnectMLS Search Form parameters OK!'));

  log(chalk.bold.magenta('Opening browser...'));

  let headless = process.env.SILENT || 'true';
  headless = headless.trim().toLowerCase();
  if (headless === 'false') {
    headless = false;
  } else if (headless === 'true') {
    headless = true;
  } else {
    headless = true;
  }

  const browser = await puppeteer.launch({
    headless: headless,
    slowMo: 10
  });
  const page = await browser.newPage();

  // Go to login page and authenticate
  log(chalk.bold.magenta('Automagically signing in...'));
  const loginDomain = 'https://sabor.connectmls.com';
  await page.goto(`${loginDomain}/cvlogin.jsp`);

  const USERNAME_SELECTOR =
    '.login-credentials .login-input input[name=userid]';
  const PASSWORD_SELECTOR =
    '.login-credentials .login-input input[name=password]';
  const SIGN_IN_SELECTOR = '.login-button input[name=login]';

  await page.click(USERNAME_SELECTOR);
  await page.keyboard.type(CREDENTIALS.username);

  await page.click(PASSWORD_SELECTOR);
  await page.keyboard.type(CREDENTIALS.password);

  await page.click(SIGN_IN_SELECTOR);
  await page.waitForSelector('#search > div');

  // Go to search Tab
  log(chalk.bold.magenta('Successfully signed in!'));
  log(chalk.bold.magenta('Navigating to search form...'));
  const SEARCH_SELECTOR = '#search > div';

  await page.click(SEARCH_SELECTOR);
  await page.waitFor(+process.env.NAVIGATE_TO_SEARCH_FORM_DELAY || 5000);

  // Manipulate search form
  log(chalk.bold.magenta('Automagically filling up details...'));
  let workspaceFrame = await page.frames().find(f => f.name() === 'workspace');

  async function setElementValue(sel, val) {
    workspaceFrame.evaluate(
      data => {
        return (document.querySelector(data.sel).value = data.val);
      },
      { sel, val }
    );
  }

  await workspaceFrame.waitForSelector('.searchFieldContainer > table');

  await setElementValue('#STATUSID', PARAMS.status);
  await setElementValue('#minSRCHPRICE', PARAMS.searchPriceMin);
  await setElementValue('#maxSRCHPRICE', PARAMS.searchPriceMax);
  await setElementValue('#MONTHS_BACKID', PARAMS.monthsBack);

  // Search results
  log(chalk.bold.magenta('Waiting for results...'));
  const searchButton = await workspaceFrame.$('#searchButtonTop');
  await searchButton.click();
  await workspaceFrame.waitForSelector('div#listingspane');

  log(chalk.bold.magenta('Preparing magic...'));
  let table = await workspaceFrame.$('div#listingspane > table');
  let rows = await table.$$('tr');
  let firstRow = await rows.find((row, index) => {
    if (index === 1) return row;
  });
  let firstRowMLSNumber = await firstRow.$('td:nth-child(3)');
  let link = await firstRowMLSNumber.$('a');
  await link.click();

  // Listing
  await workspaceFrame.waitForSelector('div#listingspane div.report');
  let domain = page.url().match(/^https?\:\/\/([^\/:?#]+)(?:[\/:?#]|$)/i)[0];

  let navpanelFrame = await page.frames().find(f => f.name() === 'navpanel');

  let totalListings = await navpanelFrame.$eval(
    'table td:nth-child(3) b:nth-child(2)',
    element => +element.innerText
  );


  let showError = (message) => {
    log(chalk.bold.bgRed.white('error @:', message));
    log(chalk.bold.bgRed.white('SKIPPING'));
    log('');
  }

  log(chalk.bold.magenta('Magic start!'));
  while (currentListingCount <= totalListings) {
    let hasFailed = false;
    if (process.env.SEARCH_RESULTS_LIMIT) {
      log(chalk.bold.bgRed.white(`SEARCH_RESULTS_LIMIT Parameter is set! Stopping @ ${process.env.SEARCH_RESULTS_LIMIT}`));
      if (currentListingCount > +process.env.SEARCH_RESULTS_LIMIT) break;
    }
    log(chalk.bold.bgGreen.white(`Processing listing ${currentListingCount} out of ${totalListings}`));    
    
    let agentDetails = {
      Name: '',
      Company: '',
      Email: '',
      Office: '',
      DirectLine: '',
      Cell: '',
      Fax: '',
      PersonalFax:''
    };

    let nextButton = await navpanelFrame.$(
      'table td:nth-child(4) > div.nextBtn'
    ).catch(() => {
      showError('Retrieving nextButton');
      hasFailed = true;
      return;
    });
    if (hasFailed || !nextButton) {
      showError('nextButton empty');
      hasFailed = true;
      errorCount++;
      currentListingCount++;      
      await navpanelFrame.waitFor(+process.env.LISTING_PAGE_DELAY || 1000);
      continue;
    }


    let agentTable = await workspaceFrame.$(
      'div#listingspane div.report table:nth-child(8)'
    ).catch(() => {
      showError('Retrieving agentTable');
      hasFailed = true;
      return;
    });
    if (hasFailed || !agentTable) {
      showError('agentTable empty');
      hasFailed = true;
      errorCount++;      
      currentListingCount++;      
      await navpanelFrame.waitFor(+process.env.LISTING_PAGE_DELAY || 1000);
      continue;
    }

    let agentLink = await agentTable.$('tr:nth-child(2) td:nth-child(2) a').catch(() => {
      showError('Retrieving agentLink');
      hasFailed = true;
      return;
    });
    if (hasFailed || !agentLink) {
      showError('agentLink empty');
      hasFailed = true;
      errorCount++;
      currentListingCount++;      
      await navpanelFrame.waitFor(+process.env.LISTING_PAGE_DELAY || 1000);
      continue;
    }

    let href = await agentLink.getProperty('href');
    let value = await href.jsonValue();
    value = value.split(`'`)[1];

    await nextButton.click();
    await navpanelFrame.waitFor(+process.env.LISTING_PAGE_DELAY || 1000);

    let currentAgentPage = await browser.newPage();
    await currentAgentPage.goto(`${domain}${value}`, { waitUntil: 'load' });
    await currentAgentPage.waitFor(+process.env.AGENT_PAGE_DELAY || 2000);

    let agent = await currentAgentPage.$eval(
      'table table table table tr strong',
      element => element.innerText
    ).catch(() => {
      showError('Retrieving agent');
      hasFailed = true;
      return;
    });
    if (hasFailed || !agent) {
      showError('agent empty');
      hasFailed = true;
      errorCount++;
      currentListingCount++;
      await currentAgentPage.close();
      await navpanelFrame.waitFor(+process.env.LISTING_PAGE_DELAY || 1000);
      continue;
    }

    log(chalk.bold.green(`Agent Name: ${agent}`));

    let details = await currentAgentPage.$eval(
      'table table table table tr:nth-child(2) td:last-child',
      element => element.innerText.split('\n')
    ).catch(() => {
      showError('Retrieving details');
      hasFailed = true;
      return;
    });
    if (hasFailed || !details) {
      showError('details empty');
      hasFailed = true;
      errorCount++;     
      currentListingCount++; 
      await currentAgentPage.close();
      await navpanelFrame.waitFor(+process.env.LISTING_PAGE_DELAY || 1000);
      continue;
    }

    log(chalk.bold.green(`Raw details scraped:`));
    log(chalk.bold.green(JSON.stringify(details, null, 2)));

    agentDetails.Name = agent.split(',')[0];
    agentDetails.Company = details.shift(); // First item, set company

    let detailsLastItem = details[details.length - 1].trim();
    if (detailsLastItem.includes('@')) {
      agentDetails.Email = detailsLastItem.split(';')[0].trim(); // Set email
      details.pop();
    }

    details.forEach(detail => {
      // UTF-8: https://stackoverflow.com/a/26301969
      let lowercasedDetail = JSON.parse(JSON.stringify(detail.trim().toLowerCase()));

      if (lowercasedDetail.startsWith('office')) {
        lowercasedDetail = lowercasedDetail.replace('office', '').trim();
        agentDetails.Office = lowercasedDetail;
      } else if (lowercasedDetail.startsWith('direct')) {
        lowercasedDetail = lowercasedDetail.replace('direct', '').replace('line', '').trim();
        agentDetails.DirectLine = lowercasedDetail;
      } else if (lowercasedDetail.startsWith('cell')) {
        lowercasedDetail = lowercasedDetail.replace('cell', '').trim();
        agentDetails.Cell = lowercasedDetail;
      } else if (lowercasedDetail.startsWith('fax')) {
        lowercasedDetail = lowercasedDetail.replace('fax', '').trim();
        agentDetails.Fax = lowercasedDetail;
      } else if (lowercasedDetail.startsWith('personal')) {
        lowercasedDetail = lowercasedDetail.replace('personal', '').replace('fax', '').trim();
        agentDetails.PersonalFax = lowercasedDetail;
      } else if (lowercasedDetail.includes('@')) {
        let email = detail.split(';')[0].trim();
        agentDetails.Email = lowercasedDetail.split(';')[0].trim();
      }
    });

    log(chalk.bold.blue(`Processed details:`));
    log(chalk.bold.blue(JSON.stringify(agentDetails, null, 2)));
    log('');

    currentListingCount++;

    if (agentDetails.Email.trim().length === 0) {
      log(chalk.bold.blue('SKIPPING. REASON: Agent doesn\'t have email'));
      continue;
    }

    allAgentDetails.push(agentDetails);
    await currentAgentPage.close();
  }

  await browser.close();

  writeToFile();

  process.exit(0);
};

scrape().catch(err => {
  log(chalk.bold.bgRed.white('--- SOMETHING WENT WRONG ---'));
  log(chalk.bold.bgRed.white('ATTEMPTING TO SAVE INITIALLY SCRAPED DATA'));
  log('');
  log(chalk.bold.bgRed.white('Report this error to the developer:'));
  log(chalk.bold.bgRed.white(err));
  log(chalk.bold.bgRed.white('--------------------------------------------'));  
  
  writeToFile();

  process.exit(0);
});

nodeCleanup((exitCode, signal) => {
  if (exitCode !== 0) {
    log(chalk.bold.bgRed.white('--- SOMETHING WENT WRONG ---'));
    log(chalk.bold.bgRed.white('ATTEMPTING TO SAVE INITIALLY SCRAPED DATA'));
    log('');
    log(chalk.bold.bgRed.white('Report this error to the developer:'));
    log(chalk.bold.bgRed.white('exitCode:', exitCode));
    log(chalk.bold.bgRed.white('signal:', signal));    
    log(chalk.bold.bgRed.white('--------------------------------------------'));  
    
    writeToFile();

    process.exit(0);
  }
});
