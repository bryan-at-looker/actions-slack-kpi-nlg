import * as Hub from "../../hub"
import * as httpRequest from "request-promise-native"
import * as nlg from './nlg_helpers'
import * as uuid from "uuid"

import { WebClient } from "@slack/client"
import * as S3 from "aws-sdk/clients/s3"
import { createDataStructure } from "./data_structure"

// const fs = require('fs')

interface Channel {
  id: string,
  label: string,
}

const apiLimitSize = 1000

export class SlackKPIBlockAction extends Hub.Action {
  allowedTags = ['Period Analysis']
  requiredFields = [{ any_tag: this.allowedTags }]
  executeInOwnProcess = true
  name = "slack-kpi-nlg"
  label = "Slack KPI NLG (Block Kit)"
  iconName = "slacknlg/slacklooker.png"
  description = "Send a KPI's Period over Period results to Looker with NLG"
  supportedActionTypes = [Hub.ActionType.Query]
  supportedFormats = [Hub.ActionFormat.JsonDetail]
  params = [
    {
      name: "slack_api_token",
      label: "Slack API Token",
      required: true,
      description: `A Slack API token that includes the permissions "channels:read", \
"users:read", and "files:write:user". You can follow the instructions to get a token at \
https://github.com/looker/actions/blob/master/src/actions/slack/README.md \
\
This action uses a http://export.highcharts.com to render an object by sending \
normalized data to the endpoint and using it in a Slack block as an image accessory. \
\
Slack's Block Kit can't upload & post, so we need to put the normalized chart on a public s3 bucket.
`,
    sensitive: true,
  }, {
    name: "access_key_id",
    label: "Access Key",
    required: true,
    sensitive: true,
    description: "Your access key for S3.",
  }, {
    name: "secret_access_key",
    label: "Secret Key",
    required: true,
    sensitive: true,
    description: "Your secret key for S3.",
  }, {
    name: "region",
    label: "Region",
    required: true,
    sensitive: false,
    description: "S3 Region e.g. us-east-1, us-west-1, ap-south-1 from " +
      "http://docs.aws.amazon.com/general/latest/gr/rande.html#s3_region.",
  }
  ]

  async execute(request: Hub.ActionRequest) {

    var d = ( request && request.attachment && request.attachment.dataJSON) ? request.attachment.dataJSON : {}
    const domain = (request && request.scheduledPlan && request.scheduledPlan.url) ? request.scheduledPlan.url.split('/')[2] : ''
    const dashboard_link = (request.formParams && request.formParams.dashboard_id) ? `https://${domain}/dashboards/${request.formParams.dashboard_id}` : ''

    if (!request.attachment || !request.attachment.dataBuffer) {
      throw "Couldn't get data from attachment."
    }

    if (!request.formParams.channel) {
      throw "Missing channel."
    }
    
    if (!d || !d.fields ) {
      throw "Query has no data or fields selected"
    } else { 
      if (!d.has_totals) {
        throw "Query doesn't have Totals"
      }
  
      if (!d.fields.pivots || d.fields.pivots.length !==1 ) {
        throw "The query needs only one pivot"
      }
  
      if (!d.fields.dimensions || d.fields.dimensions.length !== 1) {
        throw "The query needs one dimension"
      }

      if (!d.fields.measures || d.fields.measures.length !== 1) {
        throw "The query needs only one measure"
      }
    }

    // structure the data

    let response
    try {

      var data = createDataStructure(request) 
  
      var image = await this.getHighChartsImage(request, data);
      const filename = `${uuid.v4()}.png`  


      var image_to_s3 = await this.sendToS3(image, filename, request);
      const image_url = image_to_s3.Location.toString();
      // create client
      const slack = this.slackClientFromRequest(request)

      // title of the block post
      const link_title = (request.scheduledPlan && request.scheduledPlan.title) ? request.scheduledPlan.title  : ''

      // call the nlg text
      const nlg_text = [
        nlg.periods(data),
        nlg.min(data),
        nlg.max(data),
        nlg.period_growth(data, 'max'),
        nlg.period_growth(data, 'min')
      ];

      var post_options = {
        token: request.params.slack_api_token!,
        channel: request.formParams.channel,
        text: '',
        blocks: [{
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*<${dashboard_link}|${data.measure.label}: ${link_title}>*\n${nlg_text.join('. ')}`
            },
            accessory: { type: "image", image_url: image_url, alt_text:"KPI" }
          }
        ]
      }

      await slack.chat.postMessage(post_options)

    } catch (e) {
      response = { success: false, message: e }
    }
    return new Hub.ActionResponse(response)
  }

  async form(request: Hub.ActionRequest) {
    const form = new Hub.ActionForm()

    try {
      const channels = await this.usableChannels(request)
      form.fields = [{
        description: "Name of the Slack channel you would like to post to.",
        label: "Share In",
        name: "channel",
        options: channels.map((channel) => ({ name: channel.id, label: channel.label })),
        required: true,
        type: "select",
      }, {
        label: "Dashboard ID for Link",
        type: "string",
        name: "dashboard_id",
        required: false
      }
    ]

    } catch (e) {
      form.error = this.prettySlackError(e)
    }

    return form
  }

  async usableChannels(request: Hub.ActionRequest) {
    let channels = await this.usablePublicChannels(request)
    channels = channels.concat(await this.usableDMs(request))
    channels.sort((a, b) => ((a.label < b.label) ? -1 : 1 ))
    return channels
  }

  async usablePublicChannels(request: Hub.ActionRequest) {
    const slack = this.slackClientFromRequest(request)
    const options: any = {
      exclude_archived: true,
      exclude_members: true,
      limit: apiLimitSize,
    }
    async function pageLoaded(accumulatedChannels: any[], response: any): Promise<any[]> {
      const mergedChannels = accumulatedChannels.concat(response.channels)

      // When a `next_cursor` exists, recursively call this function to get the next page.
      if (response.response_metadata &&
          response.response_metadata.next_cursor &&
          response.response_metadata.next_cursor !== "") {
        const pageOptions = { ...options }
        pageOptions.cursor = response.response_metadata.next_cursor
        return pageLoaded(mergedChannels, await slack.channels.list(pageOptions))
      }
      return mergedChannels
    }
    const paginatedChannels = await pageLoaded([], await slack.channels.list(options))
    const channels = paginatedChannels.filter((c: any) => c.is_member && !c.is_archived)
    const reformatted: Channel[] = channels.map((channel: any) => ({id: channel.id, label: `#${channel.name}`}))
    return reformatted
  }

  async usableDMs(request: Hub.ActionRequest) {
    const slack = this.slackClientFromRequest(request)
    const options: any = {
      limit: apiLimitSize,
    }
    async function pageLoaded(accumulatedUsers: any[], response: any): Promise<any[]> {
      const mergedUsers = accumulatedUsers.concat(response.members)

      // When a `next_cursor` exists, recursively call this function to get the next page.
      if (response.response_metadata &&
          response.response_metadata.next_cursor &&
          response.response_metadata.next_cursor !== "") {
        const pageOptions = { ...options }
        pageOptions.cursor = response.response_metadata.next_cursor
        return pageLoaded(mergedUsers, await slack.users.list(pageOptions))
      }
      return mergedUsers
    }
    const paginatedUsers = await pageLoaded([], await slack.users.list(options))
    const users = paginatedUsers.filter((u: any) => {
      return !u.is_restricted && !u.is_ultra_restricted && !u.is_bot && !u.deleted
    })
    const reformatted: Channel[] = users.map((user: any) => ({id: user.id, label: `@${user.name}`}))
    return reformatted
  }

  private prettySlackError(e: any) {
    if (e.message === "An API error occurred: invalid_auth") {
      return "Your Slack authentication credentials are not valid."
    } else {
      return e
    }
  }

  private slackClientFromRequest(request: Hub.ActionRequest) {
    return new WebClient(request.params.slack_api_token!)
  }

  private sendToS3 (image: any, filename: string, request: any ) {
    const s3 = this.amazonS3ClientFromRequest(request);
    return s3.upload({
      Bucket: request.params.bucket,
      Key: filename,
      Body: image,
      ACL: 'public-read'
    }).promise()
  }

  // take the data and post it do
  private getHighChartsImage(_request: any, data: any) {
    //  we are using an insecure, multi-tenant endpoint for this project. Data must be normalized before sending
    const infile = {
      chart: {
        type: 'line',
        margin: [0,0,0,0],
        spacing: [0,0,0,0],
        backgroundColor: 'rgba(0, 0, 0, 1.0)',
      },    
      legend: {
        enabled: false,
      },
      title: {
        text: '',
        margin: 0
      },
      yAxis: {
        visible: false
      },
      xAxis: {
        title: '',
        visible: false
      },
      series: [{
          color: '#ECB22E',
          lineWidth: 6,
          data: data['normalized_previous_period']
        },{
          color: '#36C5F0',
          lineWidth: 12,
          data: data['normalized_this_period']
      }],
      credits: {
        enabled: false
      },
      exporting: {
        sourceWidth: 400,
        sourceHeight: 400,
        chartOptions: { subtitle: null }
      }
    }
    

    var options = { 
      method: 'POST',
      encoding: null,
      url: 'http://export.highcharts.com',
      body: { 
        async: false,
        constr: 'Chart',
        width: 400,
        scale: 1,
        type: 'image/png',
        infile: JSON.stringify(infile)
      },
      json: true 
    };
    return httpRequest.post(options).promise();
  }

  protected amazonS3ClientFromRequest(request: Hub.ActionRequest) {
    return new S3({
      region: request.params.region,
      accessKeyId: request.params.access_key_id,
      secretAccessKey: request.params.secret_access_key,
    })
  }

}

Hub.addAction(new SlackKPIBlockAction())
