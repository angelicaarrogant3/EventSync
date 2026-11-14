const express = require('express');
const router = express.Router();
const reportsService = require('../services/reports.service');
const { logActivity } = require('../services/activity.service');
const { success, error } = require('../utils/response');
const { requireRole } = require('../middleware/auth.middleware');

// GET /api/reports/summary?fromDate=&toDate= (Admin only)
router.get('/reports/summary', requireRole('administrator'), async (req, res, next) => {
  try {
    const { fromDate, toDate } = req.query;
    const summary = await reportsService.getSummaryReport({
      fromDate: fromDate || null,
      toDate: toDate || null
    });
    return success(res, summary);
  } catch (err) {
    next(err);
  }
});

// GET /api/events/:id/report?format=json|csv|xlsx|pdf (Admin only)
router.get('/events/:id/report', requireRole('administrator'), async (req, res, next) => {
  try {
    const { id } = req.params;
    const format = (req.query.format || 'json').toLowerCase();

    if (format === 'csv') {
      const csv = await reportsService.generateCsvReport(id);
      if (!csv) {
        return error(res, 'EVENT_NOT_FOUND', 'Event not found', 404);
      }
      await logActivity({ userId: req.user.id, action: 'REPORT_EXPORTED', description: `Exported CSV report for event ${id}.` });
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="attendance-report-${id}.csv"`);
      return res.status(200).send(csv);
    }

    if (format === 'xlsx') {
      const buffer = await reportsService.generateXlsxReport(id);
      if (!buffer) {
        return error(res, 'EVENT_NOT_FOUND', 'Event not found', 404);
      }
      await logActivity({ userId: req.user.id, action: 'REPORT_EXPORTED', description: `Exported Excel (.xlsx) report for event ${id}.` });
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="attendance-report-${id}.xlsx"`);
      return res.status(200).send(buffer);
    }

    if (format === 'pdf') {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `inline; filename="attendance-report-${id}.pdf"`);
      const streamed = await reportsService.streamPdfReport(id, res);
      if (!streamed) {
        return error(res, 'EVENT_NOT_FOUND', 'Event not found', 404);
      }
      await logActivity({ userId: req.user.id, action: 'REPORT_EXPORTED', description: `Exported PDF report for event ${id}.` });
      return;
    }

    const data = await reportsService.getEventReportData(id);
    if (!data) {
      return error(res, 'EVENT_NOT_FOUND', 'Event not found', 404);
    }
    return success(res, data);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
